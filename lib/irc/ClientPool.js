/*eslint no-invalid-this: 0*/
/*
 * Maintains a lookup of connected IRC clients. These connections are transient
 * and may be closed for a variety of reasons.
 */
"use strict";
var stats = require("../config/stats");
var log = require("../logging").get("ClientPool");
var Promise = require("bluebird");

const RECONNECT_TIME_MS = 10000;

function ClientPool(ircBridge) {
    this._ircBridge = ircBridge;
    // The list of bot clients on servers (not specific users)
    this._botClients = {
        // server_domain: BridgedClient
    };

    // list of virtual users on servers
    this._virtualClients = {
        // server_domain: {
        //    nicks: {
        //      <nickname>: BridgedClient
        //    },
        //    userIds: {
        //      <user_id>: BridgedClient
        //    }
        // }
    };
}

ClientPool.prototype.addBot = function(server, client) {
    if (this._botClients[server.domain]) {
        log.error(
            "Bot for %s already exists (old=%s new=%s) - disconnecting it.",
            server.domain, this._botClients[server.domain]._id, client._id
        );
        this._botClients[server.domain].disconnect();
    }
    this._botClients[server.domain] = client;
};

ClientPool.prototype.getBot = function(server) {
    return this._botClients[server.domain];
};

ClientPool.prototype.createIrcClient = function(ircClientConfig, matrixUser, isBot) {
    var bridgedClient = this._ircBridge.createBridgedClient(
        ircClientConfig, matrixUser, isBot
    );
    var server = bridgedClient.server;

    if (this._virtualClients[server.domain] === undefined) {
        this._virtualClients[server.domain] = {
            nicks: {},
            userIds: {}
        };
    }

    // add event listeners
    bridgedClient.on("client-connected", this._onClientConnected.bind(this));
    bridgedClient.on("client-disconnected", this._onClientDisconnected.bind(this));
    bridgedClient.on("nick-change", this._onNickChange.bind(this));
    bridgedClient.on("join-error", this._onJoinError.bind(this));

    // store the bridged client immediately in the pool even though it isn't
    // connected yet, else we could spawn 2 clients for a single user if this
    // function is called quickly.
    this._virtualClients[server.domain].userIds[bridgedClient.userId] = bridgedClient;

    // Does this server have a max clients limit? If so, check if the limit is
    // reached and start cycling based on oldest time.
    this._checkClientLimit(server);
    return bridgedClient;
};

ClientPool.prototype.getBridgedClientByUserId = function(server, userId) {
    if (!this._virtualClients[server.domain]) {
        return undefined;
    }
    var cli = this._virtualClients[server.domain].userIds[userId];
    if (!cli || cli.isDead()) {
        return undefined;
    }
    return cli;
};

ClientPool.prototype.getBridgedClientByNick = function(server, nick) {
    var bot = this.getBot(server);
    if (bot && bot.nick === nick) {
        return bot;
    }

    if (!this._virtualClients[server.domain]) {
        return undefined;
    }
    var cli = this._virtualClients[server.domain].nicks[nick];
    if (!cli || cli.isDead()) {
        return undefined;
    }
    return cli;
};

ClientPool.prototype.getBridgedClientsForUserId = function(userId) {
    var domainList = Object.keys(this._virtualClients);
    var clientList = [];
    domainList.forEach((domain) => {
        var cli = this._virtualClients[domain].userIds[userId];
        if (cli && !cli.isDead()) {
            clientList.push(cli);
        }
    });
    return clientList;
};

ClientPool.prototype._checkClientLimit = function(server) {
    if (server.getMaxClients() === 0) {
        return;
    }

    var numConnections = this._getNumberOfConnections(server);
    this._sendConnectionMetric(server);

    if (numConnections < server.getMaxClients()) {
        // under the limit, we're good for now.
        log.debug(
            "%s active connections on %s",
            numConnections, server.domain
        );
        return;
    }

    log.debug(
        "%s active connections on %s (limit %s)",
        numConnections, server.domain, server.getMaxClients()
    );

    // find the oldest client to kill.
    var oldest = null;
    Object.keys(this._virtualClients[server.domain].nicks).forEach((nick) => {
        var client = this._virtualClients[server.domain].nicks[nick];
        if (!client) {
            // possible since undefined/null values can be present from culled entries
            return;
        }
        if (client.isBot) {
            return; // don't ever kick the bot off.
        }
        if (oldest === null) {
            oldest = client;
            return;
        }
        if (client.getLastActionTs() < oldest.getLastActionTs()) {
            oldest = client;
        }
    });
    if (!oldest) {
        return;
    }
    // disconnect and remove mappings.
    this._removeBridgedClient(oldest);
    oldest.disconnect("Client limit exceeded: " + server.getMaxClients()).done(
    function() {
        log.info("Client limit exceeded: Disconnected %s on %s.",
            oldest.nick, oldest.server.domain);
    },
    function(e) {
        log.error("Error when disconnecting %s on server %s: %s",
            oldest.nick, oldest.server.domain, JSON.stringify(e));
    });
};

ClientPool.prototype._getNumberOfConnections = function(server) {
    if (!server || !this._virtualClients[server.domain]) { return 0; }

    var connectedNickMap = this._virtualClients[server.domain].nicks;

    var numConnectedNicks = Object.keys(connectedNickMap).filter(function(nick) {
        return Boolean(connectedNickMap[nick]); // remove 'undefined' values
    }).length;

    return numConnectedNicks;
};

ClientPool.prototype._sendConnectionMetric = function(server) {
    stats.ircClients(server.domain, this._getNumberOfConnections(server));
};

ClientPool.prototype._removeBridgedClient = function(bridgedClient) {
    var server = bridgedClient.server;
    this._virtualClients[server.domain].userIds[bridgedClient.userId] = undefined;
    this._virtualClients[server.domain].nicks[bridgedClient.nick] = undefined;
};

ClientPool.prototype._onClientConnected = function(bridgedClient) {
    var server = bridgedClient.server;
    var oldNick = bridgedClient.nick;
    var actualNick = bridgedClient.unsafeClient.nick;

    // assign a nick to this client
    this._virtualClients[server.domain].nicks[actualNick] = bridgedClient;

    // informative logging
    if (oldNick !== actualNick) {
        log.debug("Connected with nick '%s' instead of desired nick '%s'",
            actualNick, oldNick);
    }
};

ClientPool.prototype._onClientDisconnected = function(bridgedClient) {
    this._removeBridgedClient(bridgedClient);
    this._sendConnectionMetric(bridgedClient.server);

    if (bridgedClient.explicitDisconnect) {
        // don't reconnect users which explicitly disconnected e.g. client
        // cycling, idle timeouts, leaving rooms, etc.
        return;
    }
    // Reconnect this user
    log.debug(
        "onClientDisconnected: <%s> Reconnecting %s@%s in %sms",
        bridgedClient._id, bridgedClient.nick, bridgedClient.server.domain, RECONNECT_TIME_MS
    );
    // change the client config to use the current nick rather than the desired nick. This
    // makes sure that the client attempts to reconnect with the *SAME* nick, and also draws
    // from the latest !nick change, as the client config here may be very very old.
    var cliConfig = bridgedClient.getClientConfig();
    cliConfig.setDesiredNick(bridgedClient.nick);


    var cli = this.createIrcClient(
        cliConfig, bridgedClient.matrixUser, bridgedClient.isBot
    );
    var chanList = bridgedClient.chanList;
    var self = this;
    // remove ref to the disconnected client so it can be GC'd. If we don't do this,
    // the timeout below holds it in a closure, preventing it from being GC'd.
    bridgedClient = undefined;
    setTimeout(function() {
        cli.connect().then(function() {
            log.info(
                "<%s> Reconnected %s@%s", cli._id, cli.nick, cli.server.domain
            );
            if (chanList.length > 0) {
                log.info("<%s> Rejoining %s channels", cli._id, chanList.length);
                chanList.forEach(function(c) {
                    cli.joinChannel(c);
                });
            }
            self._sendConnectionMetric(cli.server);
        }, function(e) {
            log.error(
                "<%s> Failed to reconnect %s@%s", cli._id, cli.nick, cli.server.domain
            );
        });
    }, RECONNECT_TIME_MS);
};

ClientPool.prototype._onNickChange = function(bridgedClient, oldNick, newNick) {
    this._virtualClients[bridgedClient.server.domain].nicks[oldNick] = undefined;
    this._virtualClients[bridgedClient.server.domain].nicks[newNick] = bridgedClient;
};

ClientPool.prototype._onJoinError = Promise.coroutine(function*(bridgedClient, chan, err) {
    var errorsThatShouldKick = [
        "err_bannedfromchan", // they aren't allowed in channels they are banned on.
        "err_inviteonlychan", // they aren't allowed in invite only channels
        "err_channelisfull", // they aren't allowed in if the channel is full
        "err_badchannelkey" // they aren't allowed in channels with a bad key
    ];
    if (errorsThatShouldKick.indexOf(err) === -1) {
        return;
    }
    if (!bridgedClient.userId || bridgedClient.isBot) {
        return; // the bot itself can get these join errors
    }
    // TODO: this is a bit evil, no one in their right mind would expect
    // the client pool to be kicking matrix users from a room :(
    log.info(`Kicking ${bridgedClient.userId} from room due to ${err}`);
    let matrixRooms = yield this._ircBridge.getStore().getMatrixRoomsForChannel(
        bridgedClient.server, chan
    );
    let promises = matrixRooms.map((room) => {
        return this._ircBridge.getAppServiceBridge().getIntent().kick(
            room.getId(), bridgedClient.userId, `IRC error on ${chan}: ${err}`
        );
    });
    yield Promise.all(promises);
});

module.exports = ClientPool;
