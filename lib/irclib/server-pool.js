/*
 * Maintains a lookup of connected IRC clients. These connection are transient
 * and may be closed for a variety of reasons.
 */
"use strict";
(function() { // function wrap for closure compiler to scope correctly

var log = require("../logging").get("server-pool");
// The list of bot clients on servers (not specific users)
var botClients = {
    // server_domain: Client
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

module.exports.storeVirtualUser = function(virtualUser) {
    var server = virtualUser.server;

    if (virtualClients[server.domain] === undefined) {
        virtualClients[server.domain] = {
            nicks: {},
            userIds: {},
            desiredNicks: {}
        };
    }

    var userId = virtualUser.userId;
    var nick = virtualUser.nick;
    virtualClients[server.domain].userIds[userId] = virtualUser;
    virtualClients[server.domain].desiredNicks[nick] = virtualUser;

    // Does this server have a max clients limit? If so, check if the limit is
    // reached and start cycling based on oldest time.
    checkClientLimit(server);
};

module.exports.onConnected = function(virtualUser) {
    var server = virtualUser.server;
    var oldNick = virtualUser.nick;
    var actualNick = virtualUser.client.nick;

    // move from desired to actual.
    virtualClients[server.domain].desiredNicks[oldNick] = undefined;
    virtualClients[server.domain].nicks[actualNick] = virtualUser;

    // informative logging
    if (oldNick !== actualNick) {
        log.debug("Connected with nick '%s' instead of desired nick '%s'",
            actualNick, oldNick);
    }
};

module.exports.updateIrcNick = function(virtualUser, oldNick, newNick) {
    virtualClients[virtualUser.server.domain].nicks[oldNick] = undefined;
    virtualClients[virtualUser.server.domain].nicks[newNick] = virtualUser;
};

module.exports.getExistingVirtualUserByUserId = function(server, userId) {
    if (!virtualClients[server.domain]) {
        return undefined;
    }
    return virtualClients[server.domain].userIds[userId];
};

module.exports.getExistingVirtualUserByNick = function(server, nick) {
    if (!virtualClients[server.domain]) {
        return undefined;
    }
    return virtualClients[server.domain].nicks[nick];
};

module.exports.getVirtualIrcUsersForUserId = function(userId) {
    var domainList = Object.keys(virtualClients);
    var clientList = [];
    domainList.forEach(function(domain) {
        if (virtualClients[domain].userIds[userId]) {
            clientList.push(virtualClients[domain].userIds[userId]);
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
    // find the oldest client to kill.
    var oldest = null;
    Object.keys(virtualClients[server.domain].nicks).forEach(function(nick) {
        var client = virtualClients[server.domain].nicks[nick];
        if (!client) {
            // possible since undefined/null values can be present from culled entries
            return;
        }
        if (oldest === null) {
            oldest = client;
            return;
        }
        if (client.getLastActionTs() < oldest.getLastActionTs()) {
            oldest = client;
        }
    });
    // disconnect and remove mappings.
    virtualClients[server.domain].userIds[oldest.userId] = undefined;
    virtualClients[server.domain].nicks[oldest.nick] = undefined;
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

})();
