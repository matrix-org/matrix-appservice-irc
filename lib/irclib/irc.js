/*
 * Public API for interacting with IRC.
 */
"use strict";
var q = require("q");
var pool = require("./server-pool");
var ircModels = require("./models");
var models = require("../models");
var identifiers = require("../identifiers");
var store = require("../store");
var VirtualIrcUser = ircModels.VirtualIrcUser;

var servers = [];
var globalHooks = {
    onMessage: function(server, from, to, kind, msg){}
};

var loginToServer = function(server) {
    var promise = store.getTrackedChannelsForServer(server.domain).then(
            function(channels) {
        return server.connect(channels, globalHooks);
    }).then(function(client) {
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

module.exports.checkNickExists = function(server, nick) {
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
    store.waitForDatabase().done(function() {
        servers.forEach(function(server) {
            loginToServer(server);
        });
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

    var nick = identifiers.createIrcNickForUserId(userId);
    virtualUser = new VirtualIrcUser(server, nick, userId);
    virtualUser.connect(globalHooks).done(function() {
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
    return module.exports.getVirtualUserByNick(server, nick) !== undefined;
};

module.exports.getVirtualUserByNick = function(server, nick) {
    return pool.getExistingVirtualUserByNick(server, nick);
};

module.exports.trackChannel = function(server, channel) {
    var defer = q.defer();
    getBotClient(server).then(function(client) {
        client.join(channel, function() {
            var room = models.createIrcRoom(server, channel);
            defer.resolve(room);
        });
    }, function(err) {
        defer.reject(err);
    });
    return defer.promise;
};

module.exports.getServers = function() {
    return servers;
};