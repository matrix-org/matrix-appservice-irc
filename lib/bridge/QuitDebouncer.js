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
      //   rejoinsByNick: {
      //     $nick: {
      //       promise: Promise, //Promise that resolves if the user joins a channel having quit
      //       resolve: Function //function to call when a user joins
      //     }
      //   },
      //   recentQuits: 0, // the number of recent parts with kind = quit
      //   quitsPerSecond: 0, // the number of quits in the last interval 1s
      //   isSplitOccuring: false // whether a net-split is ongoing for this server
      // }
    };
}

QuitDebouncer.prototype.start = function() {
    setInterval(() => {
        Object.keys(this._debouncerForServer).forEach(
            (server) => {
                let debouncer = this._debouncerForServer[server];
                debouncer.quitsPerSecond = debouncer.recentQuits;
                debouncer.recentQuits = 0;
            }
        );
    }, 1000);
}


/**
 * Called when the IrcHandler receives a JOIN. This resolves any promises to join that were made
 * when a quit was debounced during a split.
 * @param {string} nick The nick of the IRC user joining.
 * @param {IrcServer} server The sending IRC server.
 */
QuitDebouncer.prototype.onJoin = function (nick, server) {
    let rejoin = this._debouncerForServer[server.domain].rejoinsByNick[nick];
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
QuitDebouncer.prototype.debounceQuit = Promise.coroutine(function*(req, server, matrixUser) {
    // Initialise counters for quit statistics
    if (this._debouncerForServer[server.domain] === undefined) {
        this._debouncerForServer[server.domain] = {
            rejoinsByNick: {},
            recentQuits: 0,
            quitsPerSecond: 0,
            isSplitOccuring: () => {
                return debouncer.quitsPerSecond > 5;
            }
        };
    }
    this._debouncerForServer[server.domain].recentQuits += 1;

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
    if (!this._debouncerForServer[server.domain].isSplitOccuring()) {
        return true;
    }

    let debounceMs = server.getDebouncePartsMs();

    // We do want to immediately bridge a leave if undefined or set to 0
    if (!debounceMs) {
        return true;
    }

    req.log.info('Debouncing for ' + debounceMs + 'ms\n');

    this._debouncerForServer[server.domain].rejoinsByNick[nick] = {};

    let p = new Promise((resolve) => {
        this._debouncerForServer[server.domain].rejoinsByNick[nick].resolve = resolve;
    }).timeout(debounceMs);
    this._debouncerForServer[server.domain].rejoinsByNick[nick].promise = p;

    // Return whether the part should be bridged as a leave
    try {
        yield this._debouncerForServer[server.domain].rejoinsByNick[nick].promise;
        // User has joined a channel, presence has been set to online, do not leave rooms
        return false;
    }
    catch (err) {
        req.log.info("User did not rejoin (%s)", err.message);
        return true;
    }
});

module.exports = QuitDebouncer;
