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

var getServerForUserId = function(userId) {
    for (var i=0; i<servers.length; i++) {
        var server = servers[i];
        if (userId.indexOf("@"+server.userPrefix) === 0) {
            return server;
        }
    }
};

var getNickForUserId = function(server, userId) {
    if (userId.indexOf("@"+server.userPrefix) !== 0) {
        return;
    }
    var nickAndDomain = userId.substring(("@"+server.userPrefix).length);
    return nickAndDomain.split(":")[0];
};

var loginToServer = function(server) {
    var promise = server.connect(globalHooks);
    promise.done(function(client) {
        pool.addBot(server, client);
    },
    function(err) {
        console.error("Failed to connect to %s : %s", 
            server.domain, JSON.stringify(err));
    });
    return promise;
};

var getBotClient = function(server) {
    var botClient = pool.getBot(server);
    if (botClient) {
        return q(botClient);
    }
    var defer = q.defer();
    loginToServer(server).done(function() {
        defer.resolve(pool.getBot(server));
    },
    function(err) {
        defer.reject(err);
    });
    return defer.promise;
};

var checkNickExists = function(server, nick) {
    var defer = q.defer();
    console.log("Querying for nick %s on %s", nick, server.domain);
    getBotClient(server).done(function(client) {
        client.whois(nick, function(whois) {
            if (!whois.user) {
                defer.reject("Cannot find nick on whois.");
                return;
            }
            defer.resolve({
                server: server,
                nick: nick
            });
        });
    },
    function(err) {
        defer.reject(err);
    });

    return defer.promise;
};

module.exports.connect = function() {
    servers.forEach(function(server) {
        if (server.isTrackingChannels()) {
            // connect to the server as a bot so we can monitor chat in the
            // channels we're tracking.
            loginToServer(server);
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
        return q.reject("IRC user ID.");
    }

    var virtualUser = pool.getExistingVirtualUserByUserId(server, userId);
    if (virtualUser) {
        return q(virtualUser);
    }

    var defer = q.defer();

    // TODO check for nick clashes
    var nick = mkIrcNick(userId);
    virtualUser = new VirtualIrcUser(server, mkIrcNick(userId), userId);
    virtualUser.connect().done(function() {
        pool.storeVirtualUser(virtualUser);
        defer.resolve(virtualUser);
    },
    function(err) {
        console.error("Couldn't connect virtual user %s to %s : %s",
            nick, server.domain, JSON.stringify(err))
        defer.reject(err);
    });

    return defer.promise;
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

module.exports.checkNickForUserIdExists = function(userId) {
    var server = getServerForUserId(userId);
    if (!server) {
        return q.reject("Bad server");
    }
    var nick = getNickForUserId(server, userId);
    if (!nick) {
        return q.reject("Bad nick");
    }
    return checkNickExists(server, nick);
};