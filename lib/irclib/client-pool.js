/*
 * Maintains a lookup of connected IRC clients. These connection are transient
 * and may be closed for a variety of reasons.
 */
"use strict";
var RECONNECT_TIME_MS = 10000;
var VirtualIrcUser = require("./client").VirtualIrcUser;
var log = require("../logging").get("client-pool");
// The list of bot clients on servers (not specific users)
var botClients = {
    // server_domain: VirtualIrcUser
};

// list of virtual users on servers
var virtualClients = {
    // server_domain: {
    //    nicks: {
    //      <nickname>: VirtualIrcUser
    //    },
    //    userIds: {
    //      <user_id>: VirtualIrcUser
    //    },
    //    desiredNicks: {
    //      <nickname>: VirtualIrcUser
    //    }
    // }
};

module.exports.addBot = function(server, client) {
    botClients[server.domain] = client;
};

module.exports.getBot = function(server) {
    return botClients[server.domain];
};

module.exports.createIrcClient = function(ircUser, userId, isBot) {
    var virtualUser = new VirtualIrcUser(ircUser, userId, isBot);
    var server = virtualUser.server;

    if (virtualClients[server.domain] === undefined) {
        virtualClients[server.domain] = {
            nicks: {},
            userIds: {},
            desiredNicks: {}
        };
    }

    // add event listeners
    virtualUser.on("client-connected", onClientConnected);
    virtualUser.on("client-disconnected", onClientDisconnected);
    virtualUser.on("nick-change", onNickChange);

    // store the virtual user immediately in the pool even though it isn't
    // connected yet, else we could spawn 2 clients for a single user if this
    // function is called quickly.
    virtualClients[server.domain].userIds[virtualUser.userId] = virtualUser;
    virtualClients[server.domain].desiredNicks[virtualUser.nick] = virtualUser;

    // Does this server have a max clients limit? If so, check if the limit is
    // reached and start cycling based on oldest time.
    checkClientLimit(server);
    return virtualUser;
};

module.exports.getExistingVirtualUserByUserId = function(server, userId) {
    if (!virtualClients[server.domain]) {
        return undefined;
    }
    var cli = virtualClients[server.domain].userIds[userId];
    if (!cli || cli.isDead()) {
        return undefined;
    }
    return cli;
};

module.exports.getExistingVirtualUserByNick = function(server, nick) {
    if (!virtualClients[server.domain]) {
        return undefined;
    }
    var cli = virtualClients[server.domain].nicks[nick];
    if (!cli || cli.isDead()) {
        return undefined;
    }
    return cli;
};

module.exports.getVirtualIrcUsersForUserId = function(userId) {
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
    if (server.maxClients === 0) {
        return;
    }
    var numConnectedNicks = Object.keys(virtualClients[server.domain].nicks).length +
        Object.keys(virtualClients[server.domain].desiredNicks).length;
    if (numConnectedNicks < server.maxClients) {
        // under the limit, we're good for now.
        return;
    }
    log.debug(
        "%s connections on %s (limit %s)",
        numConnectedNicks, server.domain, server.maxClients
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
    oldest.disconnect("Client limit exceeded: " + server.maxClients).done(
    function() {
        log.info("Client limit exceeded: Disconnected %s on %s.",
            oldest.nick, oldest.server.domain);
    },
    function(e) {
        log.error("Error when disconnecting %s on server %s: %s",
            oldest.nick, oldest.server.domain, JSON.stringify(e));
    });
}

var removeVirtualUser = function(virtualUser) {
    var server = virtualUser.server;
    virtualClients[server.domain].userIds[virtualUser.userId] = undefined;
    virtualClients[server.domain].nicks[virtualUser.nick] = undefined;
};

var onClientConnected = function(virtualUser) {
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
};

var onClientDisconnected = function(virtualUser) {
    removeVirtualUser(virtualUser);
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
        virtualUser.ircUser, virtualUser.userId, virtualUser.isBot
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
        // TODO: rejoin channels!
    }, RECONNECT_TIME_MS);
};

var onNickChange = function(virtualUser, oldNick, newNick) {
    virtualClients[virtualUser.server.domain].nicks[oldNick] = undefined;
    virtualClients[virtualUser.server.domain].nicks[newNick] = virtualUser;
};
