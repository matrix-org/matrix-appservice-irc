import Bluebird from "bluebird";
import { IrcServer } from "../irc/IrcServer";
import { BridgeRequest } from "../models/BridgeRequest";
import { MatrixUser } from "matrix-appservice-bridge";
import { IrcBridge } from "../bridge/IrcBridge";

const QUIT_WAIT_DELAY_MS = 100;
const QUIT_WINDOW_MS = 1000;
const QUIT_PRESENCE = "offline";

export class QuitDebouncer {
    private debouncerForServer: {
        [domain: string]: {
            rejoinPromises: {
                [nick: string]: {
                    promise: Promise<unknown>;
                    resolve: () => void;
                };
            };
            quitTimestampsMs: number[];
        };
    };

    constructor(private ircBridge: IrcBridge) {
        // Measure the probability of a net-split having just happened using QUIT frequency.
        // This is to smooth incoming PART spam from IRC clients that suffer from a
        // net-split (or other issues that lead to mass PART-ings)
        this.debouncerForServer = {};

        // Keep a track of the times at which debounceQuit was called, and use this to
        // determine the rate at which quits are being received. This can then be used
        // to detect net splits.
        Object.keys(this.ircBridge.config.ircService.servers).forEach((domain) => {
            this.debouncerForServer[domain] = {
                rejoinPromises: {},
                quitTimestampsMs: []
            };
        });
    }

    /**
     * Called when the IrcHandler receives a JOIN. This resolves any promises to join that were made
     * when a quit was debounced during a split.
     * @param {string} nick The nick of the IRC user joining.
     * @param {IrcServer} server The sending IRC server.
     */
    public onJoin(nick: string, server: IrcServer) {
        if (!this.debouncerForServer[server.domain]) {
            return;
        }
        const rejoin = this.debouncerForServer[server.domain].rejoinPromises[nick];
        if (rejoin) {
            rejoin.resolve();
        }
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
    public async debounceQuit (req: BridgeRequest, server: IrcServer, matrixUser: MatrixUser, nick: string) {
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
        await Bluebird.delay(QUIT_WAIT_DELAY_MS);
        const isSplitOccuring = debouncer.quitTimestampsMs.length > threshold;

        // TODO: This should be replaced with "disconnected" as per matrix-appservice-irc#222
        try {
            await this.ircBridge.getIntent(
                matrixUser.getId()
            ).underlyingClient.setPresenceStatus(QUIT_PRESENCE);
        }
        catch (err) {
            req.log.error(
                `QuitDebouncer Failed to set presence to ${QUIT_PRESENCE} for user %s: %s`,
                matrixUser.getId(),
                err.message
            );
        }

        // Bridge QUITs if a net split is not occurring. This is in the case where a QUIT is
        // received for reasons such as ping timeout or IRC client (G)UI being killed.
        // We don't want to debounce users that are quiting legitimately so return early, and
        // we do want to make their virtual matrix user leave the room, so return true.
        if (!isSplitOccuring) {
            return true;
        }

        const debounceDelayMinMs = server.getQuitDebounceDelayMinMs();
        const debounceDelayMaxMs = server.getQuitDebounceDelayMaxMs();

        const debounceMs = debounceDelayMinMs + Math.random() * (
            debounceDelayMaxMs - debounceDelayMinMs
        );

        // We do want to immediately bridge a leave if <= 0
        if (debounceMs <= 0) {
            return true;
        }

        req.log.info('Debouncing for ' + debounceMs + 'ms');

        const promise = new Bluebird((resolve) => {
            debouncer.rejoinPromises[nick] = {
                resolve,
                promise
            };
        }).timeout(debounceMs);



        // Return whether the part should be bridged as a leave
        try {
            await promise;
            // User has joined a channel, presence has been set to online, do not leave rooms
            return false;
        }
        catch (err) {
            req.log.info("User did not rejoin (%s)", err.message);
            return true;
        }
    }
}
