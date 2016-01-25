/*
 * Maintains a lookup of connected IRC clients. These connection are transient
 * and may be closed for a variety of reasons.
 */
"use strict";
var RECONNECT_TIME_MS = 10000;
var stats = require("../config/stats");
var BridgedClient = require("./client").BridgedClient;
var log = require("../logging").get("client-pool");
// The list of bot clients on servers (not specific users)
var botClients = {
    // server_domain: BridgedClient
};

// list of virtual users on servers
var virtualClients = {
    // server_domain: {
    //    nicks: {
    //      <nickname>: BridgedClient
    //    },
    //    userIds: {
    //      <user_id>: BridgedClient
    //    },
    //    desiredNicks: {
    //      <nickname>: BridgedClient
    //    }
    // }
};

module.exports.addBot = function(server, client) {
    if (botClients[server.domain]) {
        log.error(
            "Bot for %s already exists (old=%s new=%s) - disconnecting it.",
            server.domain, botClients[server.domain]._id, client._id
        );
        botClients[server.domain].disconnect();
    }
    botClients[server.domain] = client;
};

module.exports.getBot = function(server) {
    return botClients[server.domain];
};

module.exports.createIrcClient = function(ircUser, matrixUser, isBot) {
    var bridgedClient = new BridgedClient(ircUser, matrixUser, isBot);
    var server = bridgedClient.server;

    if (virtualClients[server.domain] === undefined) {
        virtualClients[server.domain] = {
            nicks: {},
            userIds: {},
            desiredNicks: {}
        };
    }

    // add event listeners
    bridgedClient.on("client-connected", onClientConnected);
    bridgedClient.on("client-disconnected", onClientDisconnected);
    bridgedClient.on("nick-change", onNickChange);

    // store the bridged client immediately in the pool even though it isn't
    // connected yet, else we could spawn 2 clients for a single user if this
    // function is called quickly.
    virtualClients[server.domain].userIds[bridgedClient.userId] = bridgedClient;
    virtualClients[server.domain].desiredNicks[bridgedClient.nick] = bridgedClient;

    // Does this server have a max clients limit? If so, check if the limit is
    // reached and start cycling based on oldest time.
    checkClientLimit(server);
    return bridgedClient;
};

module.exports.getBridgedClientByUserId = function(server, userId) {
    if (!virtualClients[server.domain]) {
        return undefined;
    }
    var cli = virtualClients[server.domain].userIds[userId];
    if (!cli || cli.isDead()) {
        return undefined;
    }
    return cli;
};

module.exports.getBridgedClientByNick = function(server, nick) {
    var bot = module.exports.getBot(server);
    if (bot && bot.nick === nick) {
        return bot;
    }

    if (!virtualClients[server.domain]) {
        return undefined;
    }
    var cli = virtualClients[server.domain].nicks[nick];
    if (!cli || cli.isDead()) {
        return undefined;
    }
    return cli;
};

module.exports.getBridgedClientsForUserId = function(userId) {
    var domainList = Object.keys(virtualClients);
    var clientList = [];
    domainList.forEach(function(domain) {
        var cli = virtualClients[domain].userIds[userId];
        if (cli && !cli.isDead()) {
            clientList.push(cli);
        }
    });
    return clientList;
};

function checkClientLimit(server) {
    if (server.getMaxClients() === 0) {
        return;
    }

    var numConnections = getNumberOfConnections(server);
    sendConnectionMetric(server);

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
    Object.keys(virtualClients[server.domain].nicks).forEach(function(nick) {
        var client = virtualClients[server.domain].nicks[nick];
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
    removeVirtualUser(oldest);
    oldest.disconnect("Client limit exceeded: " + server.getMaxClients()).done(
    function() {
        log.info("Client limit exceeded: Disconnected %s on %s.",
            oldest.nick, oldest.server.domain);
    },
    function(e) {
        log.error("Error when disconnecting %s on server %s: %s",
            oldest.nick, oldest.server.domain, JSON.stringify(e));
    });
}

function getNumberOfConnections(server) {
    if (!server || !virtualClients[server.domain]) { return 0; }

    var connectedNickMap = virtualClients[server.domain].nicks;
    var connectingNickMap = virtualClients[server.domain].desiredNicks;

    var numConnectedNicks = Object.keys(connectedNickMap).filter(function(nick) {
        return Boolean(connectedNickMap[nick]); // remove 'undefined' values
    }).length;

    var numConnectingNicks = Object.keys(connectingNickMap).filter(function(nick) {
        return Boolean(connectingNickMap[nick]); // remove 'undefined' values
    }).length;

    return numConnectedNicks + numConnectingNicks;
}

function sendConnectionMetric(server) {
    stats.ircClients(server.domain, getNumberOfConnections(server));
}

function removeVirtualUser(virtualUser) {
    var server = virtualUser.server;
    virtualClients[server.domain].userIds[virtualUser.userId] = undefined;
    virtualClients[server.domain].nicks[virtualUser.nick] = undefined;
}

function onClientConnected(virtualUser) {
    var server = virtualUser.server;
    var oldNick = virtualUser.nick;
    var actualNick = virtualUser.unsafeClient.nick;

    // move from desired to actual.
    virtualClients[server.domain].desiredNicks[oldNick] = undefined;
    virtualClients[server.domain].nicks[actualNick] = virtualUser;

    // informative logging
    if (oldNick !== actualNick) {
        log.debug("Connected with nick '%s' instead of desired nick '%s'",
            actualNick, oldNick);
    }
}

function onClientDisconnected(virtualUser) {
    removeVirtualUser(virtualUser);
    sendConnectionMetric(virtualUser.server);

    if (virtualUser.explicitDisconnect) {
        // don't reconnect users which explicitly disconnected e.g. client
        // cycling, idle timeouts, leaving rooms, etc.
        return;
    }
    // Reconnect this user
    log.debug(
        "onClientDisconnected: <%s> Reconnecting %s@%s in %sms",
        virtualUser._id, virtualUser.nick, virtualUser.server.domain, RECONNECT_TIME_MS
    );
    var cli = module.exports.createIrcClient(
        virtualUser.ircUser, virtualUser.matrixUser, virtualUser.isBot
    );
    var callbacks = virtualUser.callbacks;
    var chanList = virtualUser.chanList;
    virtualUser = undefined;
    setTimeout(function() {
        cli.connect(callbacks).then(function() {
            log.info(
                "<%s> Reconnected %s@%s", cli._id, cli.nick, cli.server.domain
            );
            if (chanList.length > 0) {
                log.info("<%s> Rejoining %s channels", cli._id, chanList.length);
                chanList.forEach(function(c) {
                    cli.joinChannel(c);
                });
            }
        }, function(e) {
            log.error(
                "<%s> Failed to reconnect %s@%s", cli._id, cli.nick, cli.server.domain
            );
        });
    }, RECONNECT_TIME_MS);
}

function onNickChange(virtualUser, oldNick, newNick) {
    virtualClients[virtualUser.server.domain].nicks[oldNick] = undefined;
    virtualClients[virtualUser.server.domain].nicks[newNick] = virtualUser;
}
