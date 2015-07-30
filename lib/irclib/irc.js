/*
 * Public API for interacting with IRC.
 */
"use strict";

var q = require("q");
var log = require("../logging").get("irc");

var membershiplists = require("../membershiplists.js");
var pool = require("./server-pool");
var IrcUser = require("../models/users").IrcUser;
var store = require("../store");
var VirtualIrcUser = require("./client").VirtualIrcUser;

var servers = [];
var globalHooks = {
    onMessage: function(server, from, to, action) {},
    onJoin: function(server, nick, chan, kind) {},
    onPart: function(server, nick, chan, kind) {},
    onMode: function(server, channel, by, mode, enabled, arg) {}
};

/**
 * Obtain the IRC library in the context of the given request.
 * @constructor
 * @struct
 * @param {!Request} request : The request to scope the library to, or null for
 * no scope (e.g. something done on startup).
 * @param {Object} defaultLogger : The default logger to scope to.
 */
function IrcLib(request, defaultLogger) {
    this.request = request;
    this.log = (request ? request.log : defaultLogger);
}

module.exports.getIrcUserFromCache = function(server, userId) {
    return pool.getExistingVirtualUserByUserId(server, userId);
};

// return an irc lib for this request.
module.exports.getIrcLibFor = function(request) {
    return new IrcLib(request, log);
};

IrcLib.prototype.checkNickExists = function(server, nick) {
    this.log.info("Querying for nick %s on %s", nick, server.domain);
    return getBotClient(server).then(function(client) {
        return client.whois(nick);
    });
};

IrcLib.prototype.joinBot = function(ircRoom) {
    return getBotClient(ircRoom.server).done(function(client) {
        return client.joinChannel(ircRoom.channel);
    });
};

IrcLib.prototype.partBot = function(ircRoom) {
    this.log.info(
        "Parting bot from %s on %s", ircRoom.channel, ircRoom.server.domain
    );
    return getBotClient(ircRoom.server).then(function(client) {
        return client.leaveChannel(ircRoom.channel);
    });
};

IrcLib.prototype.getVirtualIrcUser = function(server, userId, displayName) {
    var lg = this.log;

    var virtualUser = module.exports.getIrcUserFromCache(server, userId);
    if (virtualUser) {
        lg.debug("Returning cached virtual irc user %s", userId);
        return q(virtualUser);
    }

    var defer = q.defer();

    var nick = server.getNick(userId, displayName);
    var ircUser = new IrcUser(server, nick, true);
    virtualUser = new VirtualIrcUser(ircUser, userId, false);
    lg.debug(
        "Creating virtual irc user with nick %s for %s (display name %s)",
        nick, userId, displayName
    );

    // store the virtual user immediately in the pool even though it isn't
    // connected yet, else we could spawn 2 clients for a single user if this
    // function is called quickly.
    pool.storeVirtualUser(virtualUser);
    virtualUser.connect(globalHooks).done(function() {
        defer.resolve(virtualUser);
    },
    function(err) {
        lg.error("Couldn't connect virtual user %s to %s : %s",
            nick, server.domain, JSON.stringify(err));
        defer.reject(err);
    });

    return defer.promise;
};

IrcLib.prototype.sendAction = function(ircRoom, virtualIrcUser, action) {
    if (action.sender === "bot") {
        if (!action.text) {
            return q.reject("Sender is 'bot' but no text to say!");
        }
        // modify the text to put in the sender
        switch (action.action) {
            case "image":
                action.text = "<" + virtualIrcUser.nick + "> posted an image: " +
                          action.text;
                break;
            case "file":
                action.text = "<" + virtualIrcUser.nick + "> posted a file: " +
                          action.text;
                break;
        }
        action.action = "message";
        this.log.info("Sending msg in %s as the bot", ircRoom.channel);
        return sendBotText(ircRoom, action);
    }
    else {
        this.log.info(
            "Sending msg in %s as %s", ircRoom.channel, virtualIrcUser.nick
        );
        return virtualIrcUser.sendAction(ircRoom, action);
    }
};

var getChannelsToJoin = function(server) {
    if (server.isMembershipListsEnabled()) {
        return membershiplists.getChannelsToJoin(server);
    }
    else {
        return store.getTrackedChannelsForServer(server.domain);
    }
};

var loginToServer = function(server) {
    var ircUser = new IrcUser(server, server.nick, true, server.nickPass);
    var virtualUser = new VirtualIrcUser(ircUser, "matrixirc", true);
    pool.storeVirtualUser(virtualUser);
    var chansToJoin = [];
    return getChannelsToJoin(server).then(function(channels) {
        log.info("Bot connecting to %s (%s channels) => %s",
            server.domain, (channels ? channels.length : "0"),
            JSON.stringify(channels)
        );
        chansToJoin = channels;
        return virtualUser.connect(globalHooks);
    }).then(function(client) {
        pool.addBot(server, virtualUser);
        chansToJoin.forEach(function(c) {
            virtualUser.joinChannel(c);
        });
    },
    function(err) {
        log.error("Failed to connect to %s : %s",
            server.domain, JSON.stringify(err));
        log.logErr(err);
    }).catch(log.logErr);
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

var sendBotText = function(room, action) {
    return getBotClient(room.server).then(function(client) {
        return client.sendAction(room, action);
    });
};

module.exports.connect = function() {
    var defer = q.defer();
    store.waitForDatabase().done(function() {
        var promises = [];
        servers.forEach(function(server) {
            promises.push(loginToServer(server));
        });
        q.allSettled(promises).then(function() {
            defer.resolve();
        });
    });
    return defer.promise;
};

module.exports.registerHooks = function(ircCallbacks) {
    globalHooks = ircCallbacks;
};

module.exports.setServers = function(ircServers) {
    servers = ircServers;
};

module.exports.getVirtualIrcUsersForUserId = function(userId) {
    return pool.getVirtualIrcUsersForUserId(userId);
};

module.exports.isNickVirtualUser = function(server, nick) {
    var isVirtualIrcClient = (
        pool.getExistingVirtualUserByNick(server, nick) !== undefined
    );
    if (isVirtualIrcClient) {
        return true;
    }
    var bot = pool.getBot(server);
    if (bot && bot.nick === nick) {
        return true;
    }
    return false;
};

module.exports.getServer = function(domainName) {
    for (var i = 0; i < servers.length; i++) {
        var server = servers[i];
        if (server.domain === domainName) {
            return server;
        }
    }
    return null;
};

module.exports.getVirtualUser = function(ircUser) {
    if (!ircUser) {
        return;
    }
    return pool.getExistingVirtualUserByNick(ircUser.server, ircUser.nick);
};

module.exports.trackChannel = function(server, channel) {
    return getBotClient(server).then(function(client) {
        return client.joinChannel(channel);
    }).catch(log.logErr);
};

var getServerFromUserId = function(userId) {
    for (var i = 0; i < servers.length; i++) {
        var server = servers[i];
        if (server.claimsUserId(userId)) {
            return server;
        }
    }
};

var userIdToServerNick = function(userId) {
    var server = getServerFromUserId(userId);
    if (!server) {
        return {};
    }
    var nick = server.getNickFromUserId(userId);
    return {
        server: server,
        nick: nick
    };
};

var getServerForAlias = function(alias, servers) {
    for (var i = 0; i < servers.length; i++) {
        var server = servers[i];
        if (server.claimsAlias(alias)) {
            return server;
        }
    }
};

module.exports.aliasToIrcChannel = function(alias) {
    var server = getServerForAlias(alias, servers);
    if (!server) {
        return {};
    }
    var channel = server.getChannelFromAlias(alias);
    return {
        server: server,
        channel: channel
    };
};

module.exports.matrixToIrcUser = function(user) {
    if (user.protocol !== "matrix") {
        log.error("Bad src protocol: %s", user.protocol);
        return q.reject("Bad source protocol.");
    }
    var ircInfo = userIdToServerNick(user.userId);
    if (!ircInfo.server || !ircInfo.nick) {
        return q.reject("User ID " + user.userId + " doesn't map to a server/nick");
    }
    return q(new IrcUser(ircInfo.server, ircInfo.nick, true));
};
