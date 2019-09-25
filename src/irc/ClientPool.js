/*eslint no-invalid-this: 0*/
/*
 * Maintains a lookup of connected IRC clients. These connections are transient
 * and may be closed for a variety of reasons.
 */
"use strict";
const stats = require("../config/stats");
const log = require("../logging").get("ClientPool");
const Promise = require("bluebird");
const QueuePool = require("../util/QueuePool");
const BridgeRequest = require("../models/BridgeRequest");

class ClientPool {
    constructor(ircBridge) {
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
            //    These users are in the process of being
            //    connected with an *assumed* nick.
            //    pending: {
            //
            //    }
            // }
        }

        // map of numbers of connected clients on each server
        // Counting these is quite expensive because we have to
        // ignore entries where the value is undefined. Instead,
        // just keep track of how many we have.
        this._virtualClientCounts = {
            // server_domain: number
        };

        this._reconnectQueues = {
            // server_domain: QueuePool
        };
    }

    nickIsVirtual(server, nick) {
        if (!this._virtualClients[server.domain]) {
            return false;
        }

        if (this.getBridgedClientByNick(server, nick)) {
            return true;
        }

        // The client may not have signalled to us that it's connected, but it is connect*ing*.
        const pending = Object.keys(this._virtualClients[server.domain].pending || {});
        return pending.includes(nick);
    }
}

ClientPool.prototype.killAllClients = function() {
    let domainList = Object.keys(this._virtualClients);
    let clients = [];
    domainList.forEach((domain) => {
        clients = clients.concat(
            Object.keys(this._virtualClients[domain].nicks).map(
                (nick) => this._virtualClients[domain].nicks[nick]
            )
        );

        clients = clients.concat(
            Object.keys(this._virtualClients[domain].userIds).map(
                (userId) => this._virtualClients[domain].userIds[userId]
            )
        );

        clients.push(this._botClients[domain]);
    });

    clients = clients.filter((c) => Boolean(c));

    return Promise.all(
        clients.map(
            (client) => client.kill()
        )
    );
}

ClientPool.prototype.getOrCreateReconnectQueue = function(server) {
    if (server.getConcurrentReconnectLimit() === 0) {
        return null;
    }
    let q = this._reconnectQueues[server.domain];
    if (q === undefined) {
        q = this._reconnectQueues[server.domain] = new QueuePool(
            server.getConcurrentReconnectLimit(),
            (item) => {
                log.info(`Reconnecting client. ${q.waitingItems} left.`);
                return this._reconnectClient(item);
            }
        );
    }
    return q;
};

ClientPool.prototype.setBot = function(server, client) {
    this._botClients[server.domain] = client;
};

ClientPool.prototype.getBot = function(server) {
    return this._botClients[server.domain];
};

ClientPool.prototype.createIrcClient = function(ircClientConfig, matrixUser, isBot) {
    const bridgedClient = this._ircBridge.createBridgedClient(
        ircClientConfig, matrixUser, isBot
    );
    var server = bridgedClient.server;

    if (this._virtualClients[server.domain] === undefined) {
        this._virtualClients[server.domain] = {
            nicks: Object.create(null),
            userIds: Object.create(null),
            pending: {},
        };
        this._virtualClientCounts[server.domain] = 0;
    }
    if (isBot) {
        this._botClients[server.domain] = bridgedClient;
    }

    // `pending` is used to ensure that we know if a nick belongs to a userId
    // before they have been connected. It's impossible to know for sure
    // what nick they will be assigned before being connected, but this
    // should catch most cases. Knowing the nick is important, because
    // slow clients may not send a 'client-connected' signal before a join is
    // emitted, which means ghost users may join with their nickname into matrix.
    this._virtualClients[server.domain].pending[bridgedClient.nick] = bridgedClient.userId;

    // add event listeners
    bridgedClient.on("client-connected", this._onClientConnected.bind(this));
    bridgedClient.on("client-disconnected", this._onClientDisconnected.bind(this));
    bridgedClient.on("nick-change", this._onNickChange.bind(this));
    bridgedClient.on("join-error", this._onJoinError.bind(this));
    bridgedClient.on("irc-names", this._onNames.bind(this));

    // store the bridged client immediately in the pool even though it isn't
    // connected yet, else we could spawn 2 clients for a single user if this
    // function is called quickly.
    this._virtualClients[server.domain].userIds[bridgedClient.userId] = bridgedClient;
    this._virtualClientCounts[server.domain] = this._virtualClientCounts[server.domain] + 1;

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

ClientPool.prototype.getBridgedClientsForRegex = function(userIdRegex) {
    userIdRegex = new RegExp(userIdRegex);
    const domainList = Object.keys(this._virtualClients);
    const clientList = {};
    domainList.forEach((domain) => {
        Object.keys(
            this._virtualClients[domain].userIds
        ).filter(
            (u) => userIdRegex.exec(u) !== null
        ).forEach((userId) => {
            if (!clientList[userId]) {
                clientList[userId] = [];
            }
            clientList[userId].push(this._virtualClients[domain].userIds[userId]);
        });
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
    oldest.disconnect("Client limit exceeded: " + server.getMaxClients()).then(
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
    return this._virtualClientCounts[server.domain];
};

ClientPool.prototype.countTotalConnections = function() {
    var count = 0;

    Object.keys(this._virtualClients).forEach((domain) => {
        let server = this._ircBridge.getServer(domain);
        count += this._getNumberOfConnections(server);
    });

    return count;
};

ClientPool.prototype.totalReconnectsWaiting = function (serverDomain) {
    if (this._reconnectQueues[serverDomain] !== undefined) {
        return this._reconnectQueues[serverDomain].waitingItems;
    }
    return 0;
};

ClientPool.prototype.updateActiveConnectionMetrics = function(server, ageCounter) {
    if (this._virtualClients[server] === undefined) {
        return;
    }
    const clients = Object.values(this._virtualClients[server].userIds);
    clients.forEach((bridgedClient) => {
        if (!bridgedClient || bridgedClient.isDead()) {
            // We don't want to include dead ones, or ones that don't exist.
            return;
        }
        ageCounter.bump((Date.now() - bridgedClient.getLastActionTs()) / 1000);
    });
};

ClientPool.prototype.getNickUserIdMappingForChannel = function(server, channel) {
    const nickUserIdMap = {};
    const cliSet = this._virtualClients[server.domain].userIds;
    Object.keys(cliSet).filter((userId) =>
        cliSet[userId] && cliSet[userId].chanList
            && cliSet[userId].chanList.includes(channel)
    ).forEach((userId) => {
        nickUserIdMap[cliSet[userId].nick] = userId;
    });
    // Correctly map the bot too.
    nickUserIdMap[server.getBotNickname()] = this._ircBridge.getAppServiceUserId();
    return nickUserIdMap;
};

ClientPool.prototype._sendConnectionMetric = function(server) {
    stats.ircClients(server.domain, this._getNumberOfConnections(server));
};

ClientPool.prototype._removeBridgedClient = function(bridgedClient) {
    var server = bridgedClient.server;
    this._virtualClients[server.domain].userIds[bridgedClient.userId] = undefined;
    this._virtualClients[server.domain].nicks[bridgedClient.nick] = undefined;
    this._virtualClientCounts[server.domain] = this._virtualClientCounts[server.domain] - 1;

    if (bridgedClient.isBot) {
        this._botClients[server.domain] = undefined;
    }
};

ClientPool.prototype._onClientConnected = function(bridgedClient) {
    var server = bridgedClient.server;
    var oldNick = bridgedClient.nick;
    var actualNick = bridgedClient.unsafeClient.nick;

    // remove the pending nick we had set for this user
    delete this._virtualClients[server.domain].pending[oldNick];

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

    // remove the pending nick we had set for this user
    if (this._virtualClients[bridgedClient.server]) {
        delete this._virtualClients[bridgedClient.server].pending[bridgedClient.nick];
    }

    if (bridgedClient.disconnectReason === "banned") {
        const req = new BridgeRequest(this._ircBridge._bridge.getRequestFactory().newRequest());
        this._ircBridge.matrixHandler.quitUser(
            req, bridgedClient.userId, [bridgedClient],
            null, "User was banned from the network"
        );
    }

    if (bridgedClient.explicitDisconnect) {
        // don't reconnect users which explicitly disconnected e.g. client
        // cycling, idle timeouts, leaving rooms, etc.
        return;
    }
    // Reconnect this user
    // change the client config to use the current nick rather than the desired nick. This
    // makes sure that the client attempts to reconnect with the *SAME* nick, and also draws
    // from the latest !nick change, as the client config here may be very very old.
    var cliConfig = bridgedClient.getClientConfig();
    cliConfig.setDesiredNick(bridgedClient.nick);


    var cli = this.createIrcClient(
        cliConfig, bridgedClient.matrixUser, bridgedClient.isBot
    );
    var chanList = bridgedClient.chanList;
    // remove ref to the disconnected client so it can be GC'd. If we don't do this,
    // the timeout below holds it in a closure, preventing it from being GC'd.
    bridgedClient = undefined;

    if (chanList.length === 0) {
        log.info(`Dropping ${cli._id} ${cli.nick} because they are not joined to any channels`);
        return;
    }
    let queue = this.getOrCreateReconnectQueue(cli.server);
    if (queue === null) {
        this._reconnectClient({
            cli: cli,
            chanList: chanList,
        });
        return;
    }
    queue.enqueue(cli._id, {
        cli: cli,
        chanList: chanList,
    });
};

ClientPool.prototype._reconnectClient = function(cliChan) {
    const cli = cliChan.cli;
    const chanList = cliChan.chanList;
    return cli.connect().then(() => {
        log.info(
            "<%s> Reconnected %s@%s", cli._id, cli.nick, cli.server.domain
        );
        log.info("<%s> Rejoining %s channels", cli._id, chanList.length);
        chanList.forEach(function(c) {
            cli.joinChannel(c);
        });
        this._sendConnectionMetric(cli.server);
    }, (e) => {
        log.error(
            "<%s> Failed to reconnect %s@%s", cli._id, cli.nick, cli.server.domain
        );
    });
}

ClientPool.prototype._onNickChange = function(bridgedClient, oldNick, newNick) {
    this._virtualClients[bridgedClient.server.domain].nicks[oldNick] = undefined;
    this._virtualClients[bridgedClient.server.domain].nicks[newNick] = bridgedClient;
};

ClientPool.prototype._onJoinError = Promise.coroutine(function*(bridgedClient, chan, err) {
    var errorsThatShouldKick = [
        "err_bannedfromchan", // they aren't allowed in channels they are banned on.
        "err_inviteonlychan", // they aren't allowed in invite only channels
        "err_channelisfull", // they aren't allowed in if the channel is full
        "err_badchannelkey", // they aren't allowed in channels with a bad key
        "err_needreggednick", // they aren't allowed in +r channels if they haven't authed
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

ClientPool.prototype._onNames = Promise.coroutine(function*(bridgedClient, chan, names) {
    let mls = this._ircBridge.memberListSyncers[bridgedClient.server.domain];
    if (!mls) {
        return;
    }
    yield mls.updateIrcMemberList(chan, names);
});

module.exports = ClientPool;
