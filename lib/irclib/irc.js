"use strict";
var q = require("q");
var pool = require("./server-pool");
var models = require("./models");
var IrcRoom = models.IrcRoom;
var VirtualIrcUser = models.VirtualIrcUser;

var servers = [];
var globalHooks = {
    onMessage: function(server, from, to, kind, msg){}
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
            pool.addBot(server, server.connect(globalHooks));
        }
    });
};

module.exports.registerHooks = function(ircCallbacks) {
    globalHooks = ircCallbacks;
};

module.exports.setServers = function(ircServers) {
    servers = ircServers;
};

module.exports.getVirtualIrcUser = function(server, userId) {
    if (userId.indexOf("@"+server.userPrefix) == 0) {
        // this is an echo of a virtual user, not a real user, bail out.
        return undefined;
    }

    var virtualUser = pool.getExistingVirtualUserByUserId(server, userId);
    if (!virtualUser) {
        // TODO check for nick clashes
        var nick = mkIrcNick(userId);
        virtualUser = new VirtualIrcUser(server, mkIrcNick(userId), userId);
        virtualUser.connect();
        pool.storeVirtualUser(virtualUser);
    }

    return virtualUser;
};

module.exports.isNickVirtualUser = function(server, nick) {
    return pool.getExistingVirtualUserByNick(server, nick) !== undefined;
};

module.exports.trackChannel = function(server, channel) {
    // TODO: Track the channel
    // If we have a bot already on this server, just make them join the channel.
    // If we don't, then connect as a bot to this server, add it to botClients
    // and join the room.
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