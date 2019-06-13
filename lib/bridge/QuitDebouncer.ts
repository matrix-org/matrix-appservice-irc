
import { BridgeRequest } from "../models/BridgeRequest";
import { IrcServer } from "../irc/IrcServer";
import PromiseUtil from "../promiseutil";

const QUIT_WAIT_DELAY_MS = 100;
const QUIT_WINDOW_MS = 1000;
const QUIT_PRESENCE = "offline";

interface IServerDebouncer {
    rejoinPromises: {[nick: string]: {
        // Promise that resolves if the user joins a channel having quit
        promise: Promise<void>,
        // Resolving function of the promise to call when a user joins
        resolve: () => void}
    }
    /**
     * Timestamps recorded per-server when debounceQuit is called. Old timestamps are removed when a new timestamp is added.
     */
    quitTimestampsMs: number[]
}

export class QuitDebouncer {
    private debouncerForServer: { [domain: string]: IServerDebouncer } = {};
    constructor (private ircBridge) {
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
        let rejoin = this.debouncerForServer[server.domain].rejoinPromises[nick];
        if (rejoin) {
            rejoin.resolve();
        }
    }

    /**
     * Debounce a QUIT received by the IrcHandler to prevent net-splits from spamming leave events
     * into a room when incremental membership syncing is enabled.
     * @param {BridgeRequest} req The metadata request.
     * @param {IrcServer} server The sending IRC server.
     * @param {MatrixUser} matrixUser The virtual user of the user that sent QUIT.
     * @param {string} nick The nick of the IRC user quiting.
     * @return {Promise<boolean>} which resolves to true if a leave should be sent, false otherwise.
     */
    public async debounceQuit(req: BridgeRequest, server: IrcServer, matrixUser: any, nick: string): Promise<boolean> {
        // Maintain the last windowMs worth of timestamps corresponding with calls to this function.
        const debouncer = this.debouncerForServer[server.domain];
        const now = Date.now();
    
        debouncer.quitTimestampsMs.push(now);
        const threshold = server.getDebounceQuitsPerSecond(); // Rate of quits to call net-split
        // Filter out timestamps from more than QUIT_WINDOW_MS ago
        debouncer.quitTimestampsMs = debouncer.quitTimestampsMs.filter((t) => t > (now - QUIT_WINDOW_MS));
        // Wait for a short time to allow other potential splitters to send QUITs
        await PromiseUtil.delayFor(QUIT_WAIT_DELAY_MS);
        const isSplitOccuring = debouncer.quitTimestampsMs.length > threshold;
        // TODO: This should be replaced with "disconnected" as per matrix-appservice-irc#222
        try {
            await this.ircBridge.getAppServiceBridge().getIntent(matrixUser.getId()).setPresence(QUIT_PRESENCE);
        }
        catch (err) {
            req.log.error(`QuitDebouncer Failed to set presence to ${QUIT_PRESENCE} for user %s: %s`, matrixUser.getId(), err.message);
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
        const debounceMs = debounceDelayMinMs + Math.random() * (debounceDelayMaxMs - debounceDelayMinMs);
        // We do want to immediately bridge a leave if <= 0
        if (debounceMs <= 0) {
            return true;
        }
        req.log.info('Debouncing for ' + debounceMs + 'ms');
        debouncer.rejoinPromises[nick] = {
            promise: null,
            resolve: null,
        };
        let p = PromiseUtil.timeoutForPromise(new Promise((resolve) => {
            debouncer.rejoinPromises[nick].resolve = resolve;
        }), debounceMs);
        debouncer.rejoinPromises[nick].promise = p;
        // Return whether the part should be bridged as a leave
        try {
            await debouncer.rejoinPromises[nick].promise;
            // User has joined a channel, presence has been set to online, do not leave rooms
            return false;
        }
        catch (err) {
            req.log.info("User did not rejoin (%s)", err.message);
            return true;
        }
    }
}