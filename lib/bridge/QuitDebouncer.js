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
            // $nick: {
            //   promise: Promise, //Promise that resolves if the user joins a channel having quit
            //   resolve: Function //function to call when a user joins
            // }
      // }
    };

    // Keep a track of the times at which debounceQuit was called, and use this to
    // determine the rate at which quits are being received. This can then be used
    // to detect net splits.
    /*$server : [1477386173850, 1477386173825, ...]*/
    this._quitTimestampsMs = {};
    Object.keys(this.ircBridge.config.ircService.servers).forEach((domain) => {
        this._quitTimestampsMs[domain] = [];
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
    let rejoin = this._debouncerForServer[server.domain][nick];
    if (rejoin) {
        rejoin.resolve()
    }
}

/**
 * Debounce a QUIT received by the IrcHandler to prevent net-splits from spamming leave events
 * into a room when incremental membership syncing is enabled.
 * @param {Request} req The metadata request.
 * @param {IrcServer} server The sending IRC server.
 * @param {string} matrixUser The virtual user of the user that sent QUIT.
 * @return {Promise} which resolves to true if a leave should be sent, false otherwise.
 */
QuitDebouncer.prototype.debounceQuit = Promise.coroutine(function*(req, server, matrixUser, nick) {
    // Maintain the last windowMs worth of timestamps corresponding with calls to this function.
    let now = Date.now();
    let windowMs = 1000;// Window starts 1s ago
    let threshold = server.getDebounceQuitsPerSecond();// Need 5Hz of quits to call net-split
    this._quitTimestampsMs[server.domain].push(now);

    // Filter out timestamps from more than 1s ago
    this._quitTimestampsMs[server.domain] = this._quitTimestampsMs[server.domain].filter(
        (t) => t > now - windowMs
    );

    // Wait for a short time to allow other potential splitters to send QUITs
    yield Promise.delay(100);

    let isSplitOccuring = this._quitTimestampsMs[server.domain].length > threshold;

    if (this._debouncerForServer[server.domain] === undefined) {
        this._debouncerForServer[server.domain] = {};
    }

    // TODO: This should be replaced with "disconnected" as per matrix-appservice-irc#222
    let presence = "offline";
    try {
        yield this.ircBridge.getAppServiceBridge().getIntent(
            matrixUser.getId()
        ).client.setPresence(presence);
    }
    catch (err) {
        req.log.error(
            'QuitDebouncer Failed to set presence to offline for user %s',
            matrixUser.getId()
        );
    }

    // Bridge QUITs if a net split is not occurring. This is in the case where a QUIT is
    // received for reasons such as ping timeout or IRC client (G)UI being killed.
    // We don't want to debounce users that are quiting legitimately so return early, and
    // we do want to make their virtual matrix user leave the room, so return true.
    if (!isSplitOccuring) {
        return true;
    }

    let debounceMs = server.getQuitDebounceDelayMs();

    // We do want to immediately bridge a leave if undefined or set to 0
    if (!debounceMs) {
        return true;
    }

    req.log.info('Debouncing for ' + debounceMs + 'ms\n');

    this._debouncerForServer[server.domain][nick] = {};

    let p = new Promise((resolve) => {
        this._debouncerForServer[server.domain][nick].resolve = resolve;
    }).timeout(debounceMs);
    this._debouncerForServer[server.domain][nick].promise = p;

    // Return whether the part should be bridged as a leave
    try {
        yield this._debouncerForServer[server.domain][nick].promise;
        // User has joined a channel, presence has been set to online, do not leave rooms
        return false;
    }
    catch (err) {
        req.log.info("User did not rejoin (%s)", err.message);
        return true;
    }
});

module.exports = QuitDebouncer;
