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
        // $server => {integer} : the number of recent parts with kind = quit
    };
    this._quitsPerSecond = {
        // $server => {integer} : the number of quits in the last interval 1s
    };

    this._is_split_occuring = {
        // $server => {bool}
    };

    setInterval(() => {
        Object.keys(this._recentQuits).forEach(
            (server) => {
                this._quitsPerSecond[server] = this._recentQuits[server];
                this._recentQuits[server] = 0;

                let threshold = 5;

                // Possible net-split
                if (this._quitsPerSecond[server] > threshold) {
                    this._is_split_occuring = true;
                }
            }
        );
    }, 1000);
}

// resolve any promise to rejoin
QuitDebouncer.prototype.onJoin = function (nick, server) {
    if (this._rejoinPromises[nick + ' ' + server.domain]) {
        this._rejoinResolvers[nick + ' ' + server.domain]();
    }
}

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

    let debounce = this._is_split_occuring ? server.getDeboucePartsMs() : 0;

    if (this._is_split_occuring) {
        console.log('\nDebouncing for ' + debounce + 'ms\n');
    }
    this._rejoinPromises[nick + ' ' + server.domain] = new Promise((resolve) => {
        this._rejoinResolvers[nick + ' ' + server.domain] = resolve;
    }).timeout(debounce);

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
