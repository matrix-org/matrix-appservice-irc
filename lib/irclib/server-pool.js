"use strict";
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



