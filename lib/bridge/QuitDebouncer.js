/*eslint no-invalid-this: 0*/
"use strict";
var Promise = require("bluebird");

function QuitDebouncer(ircBridge) {
    this.ircBridge = ircBridge;

    // Measure the probability of a net-split having just happened using QUIT frequency.
    // This is to smooth incoming PART spam from IRC clients that suffer from a
    // net-split (or other issues that lead to mass PART-ings)
    this._debouncerForServer = {
        // $server.domain: {
        //     rejoinPromises: {
        //             $nick: {
        //                // Promise that resolves if the user joins a channel having quit
        //                promise: Promise,
        //                // Resolving function of the promise to call when a user joins
        //                resolve: Function
        //          }
        //     },
        //     // Timestamps recorded per-server when debounceQuit is called. Old timestamps
        //     // are removed when a new timestamp is added.
        //     quitTimestampsMs:{
        //         $server : [1477386173850, 1477386173825, ...]
        //     }
        // }
    };

    // Keep a track of the times at which debounceQuit was called, and use this to
    // determine the rate at which quits are being received. This can then be used
    // to detect net splits.
    Object.keys(this.ircBridge.config.ircService.servers).forEach((domain) => {
        this._debouncerForServer[domain] = {
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
QuitDebouncer.prototype.onJoin = function (nick, server) {
    if (!this._debouncerForServer[server.domain]) {
        return;
    }
    let rejoin = this._debouncerForServer[server.domain].rejoinPromises[nick];
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
QuitDebouncer.prototype.debounceQuit = Promise.coroutine(function*(req, server, matrixUser, nick) {
    // Maintain the last windowMs worth of timestamps corresponding with calls to this function.
    let debouncer = this._debouncerForServer[server.domain];

    let now = Date.now();
    debouncer.quitTimestampsMs.push(now);

    let windowMs = 1000;// Window starts 1s ago
    let threshold = server.getDebounceQuitsPerSecond();// Rate of quits to call net-split

    // Filter out timestamps from more than windowMs ago
    debouncer.quitTimestampsMs = debouncer.quitTimestampsMs.filter(
        (t) => t > (now - windowMs)
    );

    // Wait for a short time to allow other potential splitters to send QUITs
    yield Promise.delay(100);
    let isSplitOccuring = debouncer.quitTimestampsMs.length > threshold;

    // TODO: This should be replaced with "disconnected" as per matrix-appservice-irc#222
    /*let presence = "offline";
    try {
        yield this.ircBridge.getAppServiceBridge().getIntent(
            matrixUser.getId()
        ).client.setPresence(presence);
    }
    catch (err) {
        req.log.error(
            'QuitDebouncer Failed to set presence to offline for user %s: %s',
            matrixUser.getId(),
            err.message
        );
    }*/

    // Bridge QUITs if a net split is not occurring. This is in the case where a QUIT is
    // received for reasons such as ping timeout or IRC client (G)UI being killed.
    // We don't want to debounce users that are quiting legitimately so return early, and
    // we do want to make their virtual matrix user leave the room, so return true.
    if (!isSplitOccuring) {
        return true;
    }

    let debounceDelayMinMs = server.getQuitDebounceDelayMinMs();
    let debounceDelayMaxMs = server.getQuitDebounceDelayMaxMs();

    let debounceMs = debounceDelayMinMs + Math.random() * (debounceDelayMaxMs - debounceDelayMinMs);

    // We do want to immediately bridge a leave if <= 0
    if (debounceMs <= 0) {
        return true;
    }

    req.log.info('Debouncing for ' + debounceMs + 'ms');

    debouncer.rejoinPromises[nick] = {};

    let p = new Promise((resolve) => {
        debouncer.rejoinPromises[nick].resolve = resolve;
    }).timeout(debounceMs);
    debouncer.rejoinPromises[nick].promise = p;

    // Return whether the part should be bridged as a leave
    try {
        yield debouncer.rejoinPromises[nick].promise;
        // User has joined a channel, presence has been set to online, do not leave rooms
        return false;
    }
    catch (err) {
        req.log.info("User did not rejoin (%s)", err.message);
        return true;
    }
});

module.exports = QuitDebouncer;
