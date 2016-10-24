/*eslint no-invalid-this: 0*/
"use strict";
var Promise = require("bluebird");

function QuitDebouncer(ircBridge) {
    this.ircBridge = ircBridge;

    this._rejoinPromises = {
        // '$nick $server.domain': Promise that resolves if the user joins a channel having quit
        //       previously
    };
    this._rejoinResolvers = {
        // '$nick $server.domain': function to call when a user joins
    };

    // Heuristic to measure the probability of a net-split having just happened
    // This is to smooth incoming PART spam from IRC clients that suffer from a
    // net-split (or other issues that lead to mass PART-ings)
    this._recentQuits = {
        // $server => {number} : the number of recent parts with kind = quit
    };
    this._quitsPerSecond = {
        // $server => {number} : the number of quits in the last interval 1s
    };

    this._isSplitOccuring = {
        // $server => {Boolean}
    };

    setInterval(() => {
        Object.keys(this._recentQuits).forEach(
            (server) => {
                this._quitsPerSecond[server] = this._recentQuits[server];
                this._recentQuits[server] = 0;

                let threshold = 5;

                // Possible net-split
                if (this._quitsPerSecond[server] > threshold) {
                    this._isSplitOccuring[server] = true;
                }
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
    if (this._rejoinPromises[nick + ' ' + server.domain]) {
        this._rejoinResolvers[nick + ' ' + server.domain]();
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
    if (this._quitsPerSecond[server.domain] === undefined) {
        this._recentQuits[server.domain] = 0;
        this._quitsPerSecond[server.domain] = 0;
    }
    this._recentQuits[server.domain] += 1;

    // TODO: This should be replaced with "disconnected" as per matrix-appservice-irc#222
    let presence = "offline";
    yield this.ircBridge.getAppServiceBridge().getIntent(
        matrixUser.getId()
    ).client.setPresence(presence);

    // Bridge parts if a split is not occuring. This is in the case where a QUIT is
    // received for reasons such as ping timeout or IRC client (G)UI being killed.
    if (!this._isSplitOccuring[server]) {
        return true;
    }

    let debounceMs = server.getDebouncePartsMs();
    console.log('\nDebouncing for ' + debounceMs + 'ms\n');
    this._rejoinPromises[nick + ' ' + server.domain] = new Promise((resolve) => {
        this._rejoinResolvers[nick + ' ' + server.domain] = resolve;
    }).timeout(debounceMs);

    // Return whether the part should be bridged as a leave
    try {
        yield this._rejoinPromises[nick + ' ' + server.domain];
        // User has joined a channel, presence has been set to online, do not leave rooms
        return false;
    }
    catch (err) {
        req.log.info("User did not rejoin (%s)", err.message);
        return true;
    }
});

module.exports = QuitDebouncer;
