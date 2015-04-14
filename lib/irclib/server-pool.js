/*
 * Maintains a lookup of connected IRC clients. These connection are transient
 * and may be closed for a variety of reasons.
 */
"use strict";
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
            nicks:{},
            userIds:{}
        };
    }
    
    var userId = virtualUser.userId;
    var nick = virtualUser.nick;
    virtualClients[server.domain].userIds[userId] = virtualUser;
    virtualClients[server.domain].nicks[nick] = virtualUser;

    // Does this server have a max clients limit? If so, check if the limit is
    // reached and start cycling based on oldest time.
    checkClientLimit(server);
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

module.exports.getServersForUserId = function(userId) {
    var domainList = Object.keys(virtualClients);
    var servList = [];
    domainList.forEach(function(domain) {
        if (virtualClients[domain].userIds[userId]) {
            servList.push(virtualClients[domain].userIds[userId].server);
        }
    });
    return servList;
};

function checkClientLimit(server) {
    if (server.maxClients === 0) {
        return;
    }
    var connectedNicks = Object.keys(virtualClients[server.domain].nicks);
    if (connectedNicks.length < server.maxClients) {
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
    oldest.disconnect("Client limit exceeded: "+server.maxClients).done(
    function() {
        log.info("Client limit exceeded: Disconnected %s on %s.",
            oldest.nick, oldest.server.domain);
    },
    function(e) {
        log.error("Error when disconnecting %s on server %s: %s",
            oldest.nick, oldest.server.domain, JSON.stringify(e));
    });
};
