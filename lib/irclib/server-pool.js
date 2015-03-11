"use strict";
var q = require("q");
var models = require("../models");
var IrcRoom = models.IrcRoom;
var VirtualIrcUser = models.VirtualIrcUser;

var servers = [];
var hooks = {
    onMessage: function(server, from, to, msg){
        console.log("onMessage: Implement me!");
    }
};

// The list of bot clients on servers (not specific users)
var botClients = [];

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

var mkIrcNick = function(userId) {
    // localpart only for now
    return userId.substring(1).split(":")[0];
};

module.exports.connect = function() {
    servers.forEach(function(server) {
        if (server.isTrackingChannels()) {
            // connect to the server as a bot so we can monitor chat in the
            // channels we're tracking.
            botClients.push(server.connect(hooks));
        }
    });
};

module.exports.getIrcRoomForRoomId = function(roomId) {
    // try to find the tracked channel
    for (var i=0; i<servers.length; i++) {
        var server = servers[i];
        var channels = Object.keys(server.channelToRoomIds);
        for (var k=0; k<channels.length; k++) {
            var channel = channels[k];
            for (var m=0; m<server.channelToRoomIds[channel].length; m++) {
                var chanRoomId = server.channelToRoomIds[channel][m];
                if (roomId === chanRoomId) {
                    return new IrcRoom(server, channel);
                }
            }
        }
    }
};

module.exports.getVirtualIrcUser = function(server, userId) {
    if (userId.indexOf("@"+server.userPrefix) == 0) {
        // this is an echo of a virtual user, not a real user, bail out.
        return undefined;
    }

    if (virtualClients[server.domain] === undefined) {
        virtualClients[server.domain] = {
            nicks:{},
            userIds:{}
        };
    }
    if (virtualClients[server.domain].userIds[userId] === undefined) {
        // TODO check for nick clashes
        var nick = mkIrcNick(userId);
        var user = new VirtualIrcUser(server, mkIrcNick(userId), userId);
        user.connect();
        virtualClients[server.domain].userIds[userId] = user;
        virtualClients[server.domain].nicks[nick] = user;
    }

    return virtualClients[server.domain].userIds[userId];
};

module.exports.isVirtualUser = function(server, from) {
    if (virtualClients[server.domain] === undefined) {
        return false;
    }
    return virtualClients[server.domain].nicks[from] !== undefined;
}

module.exports.trackChannel = function(server, channel) {
    // TODO: Track the channel
    // If we have a bot already on this server, just make them join the channel.
    // If we don't, then connect as a bot to this server, add it to botClients
    // and join the room.
};

module.exports.registerHooks = function(ircCallbacks) {
    hooks = ircCallbacks;
};

module.exports.setServers = function(ircServers) {
    servers = ircServers;
};