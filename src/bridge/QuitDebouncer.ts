import { IrcServer } from "../irc/IrcServer";
import Log from "../logging";
import { Queue } from "../util/Queue";

const log = Log("QuitDebouncer");

const QUIT_WINDOW_MS = 1000;

export class QuitDebouncer {
    private debouncerForServer: {
        [domain: string]: {
            quitTimestampsMs: number[];
            splitChannelUsers: Map<string, Set<string>>; //"$channel $nick"
        };
    };

    private quitProcessQueue: Queue<{channel: string; server: IrcServer; nicks: string[]}>;

    constructor(domains: string[], private handleQuit: (item: {channel: string; server: IrcServer; nicks: string[]}) => Promise<void>) {
        // Measure the probability of a net-split having just happened using QUIT frequency.
        // This is to smooth incoming PART spam from IRC clients that suffer from a
        // net-split (or other issues that lead to mass PART-ings)
        this.debouncerForServer = {};
        this.quitProcessQueue = new Queue(this.handleQuit);

        // Keep a track of the times at which debounceQuit was called, and use this to
        // determine the rate at which quits are being received. This can then be used
        // to detect net splits.
        Object.keys(domains).forEach((domain) => {
            this.debouncerForServer[domain] = {
                quitTimestampsMs: [],
                splitChannelUsers: new Map(),
            };
        });
    }

    /**
     * Called when the IrcHandler receives a JOIN. This resolves any promises to join that were made
     * when a quit was debounced during a split.
     * @param {string} nick The nick of the IRC user joining.
     * @param {IrcServer} server The sending IRC server.
     */
    public onJoin(nick: string, channel: string, server: IrcServer) {
        if (!this.debouncerForServer[server.domain]) {
            return;
        }
        const map = this.debouncerForServer[server.domain].splitChannelUsers.get(channel);
        if (!map) {
            return;
        }
        map.delete(nick);

        if (map.size === 0) {
            return;
        }
        this.quitProcessQueue.enqueue(channel+server.domain, {channel, server, nicks: [...map.values()]});
    }

    /**
     * Debounce a QUIT received by the IrcHandler to prevent net-splits from spamming leave events
     * into a room when incremental membership syncing is enabled.
     * @param {Request} req The metadata request.
     * @param {IrcServer} server The sending IRC server.
     * @param {string} matrixUser The virtual user of the user that sent QUIT.
     * @param {string} nick The nick of the IRC user quiting.
     * @return {Promise} which resolves to true if a leave should be sent, false otherwise.
     */
    public debounceQuit (nick: string, server: IrcServer, channels: string[]): boolean {
        // Maintain the last windowMs worth of timestamps corresponding with calls to this function.
        const debouncer = this.debouncerForServer[server.domain];

        const now = Date.now();
        debouncer.quitTimestampsMs.push(now);

        const threshold = server.getDebounceQuitsPerSecond();// Rate of quits to call net-split

        // Filter out timestamps from more than QUIT_WINDOW_MS ago
        debouncer.quitTimestampsMs = debouncer.quitTimestampsMs.filter(
            (t) => t > (now - QUIT_WINDOW_MS)
        );

        // Wait for a short time to allow other potential splitters to send QUITs
        const isSplitOccuring = debouncer.quitTimestampsMs.length > threshold;

        // Bridge QUITs if a net split is not occurring. This is in the case where a QUIT is
        // received for reasons such as ping timeout or IRC client (G)UI being killed.
        // We don't want to debounce users that are quiting legitimately so return early, and
        // we do want to make their virtual matrix user leave the room, so return true.
        if (!isSplitOccuring) {
            return true;
        }

        log.info(`Dropping QUIT for ${nick}`);
        channels.forEach((channel) => {
            if (!debouncer.splitChannelUsers.has(channel)) {
                debouncer.splitChannelUsers.set(channel, new Set());
            }
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            debouncer.splitChannelUsers.get(channel)!.add(nick);
        })
        return false;
    }
}
