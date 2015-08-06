/*
 * Public API for interacting with IRC.
 */
"use strict";

var q = require("q");
var log = require("../logging").get("irc");

var membershiplists = require("../membershiplists.js");
var pool = require("./client-pool");
var IrcUser = require("../models/users").IrcUser;
var MatrixUser = require("../models/users").MatrixUser;
var store = require("../store");

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
    return pool.getBridgedClientByUserId(server, userId);
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
    var self = this;
    return getBotClient(ircRoom.server).then(function(client) {
        return client.joinChannel(ircRoom.channel);
    }).catch(function(e) {
        self.log.error("Bot failed to join channel %s", ircRoom.channel);
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

IrcLib.prototype.getBridgedClient = function(server, userId, displayName) {
    var lg = this.log;

    var bridgedClient = module.exports.getIrcUserFromCache(server, userId);
    if (bridgedClient) {
        lg.debug("Returning cached bridged client %s", userId);
        return q(bridgedClient);
    }

    var defer = q.defer();

    var nick = server.getNick(userId, displayName);
    var ircUser = new IrcUser(server, nick, true);
    var mxUser = new MatrixUser(userId, displayName, false);
    lg.debug(
        "Creating virtual irc user with nick %s for %s (display name %s)",
        nick, userId, displayName
    );
    bridgedClient = pool.createIrcClient(ircUser, mxUser, false);

    // check the database for stored config information for this irc client
    // including username, custom nick, nickserv password, etc.
    var storeClient = true;
    store.ircClients.get(userId, server.domain).then(function(storedIrcUser) {
        if (!storedIrcUser) { return; }
        lg.debug("Configuring IRC user from store => %s", storedIrcUser);
        ircUser = storedIrcUser;
        bridgedClient.setIrcUserInfo(ircUser);
        storeClient = false;
    }).finally(function() {
        bridgedClient.connect(globalHooks).done(function() {
            if (storeClient) {
                store.ircClients.set(userId, bridgedClient.ircUser);
            }
            defer.resolve(bridgedClient);
        },
        function(err) {
            lg.error("Couldn't connect virtual user %s to %s : %s",
                nick, server.domain, JSON.stringify(err));
            defer.reject(err);
        });
    });

    return defer.promise;
};

IrcLib.prototype.sendAction = function(ircRoom, bridgedClient, action) {
    if (action.sender === "bot") {
        if (!action.text) {
            return q.reject("Sender is 'bot' but no text to say!");
        }
        // modify the text to put in the sender
        switch (action.action) {
            case "image":
                action.text = "<" + bridgedClient.nick + "> posted an image: " +
                          action.text;
                break;
            case "file":
                action.text = "<" + bridgedClient.nick + "> posted a file: " +
                          action.text;
                break;
        }
        action.action = "message";
        this.log.info("Sending msg in %s as the bot", ircRoom.channel);
        return sendBotText(ircRoom, action);
    }
    else {
        this.log.info(
            "Sending msg in %s as %s", ircRoom.channel, bridgedClient.nick
        );
        return bridgedClient.sendAction(ircRoom, action);
    }
};

var getChannelsToJoin = function(server) {
    if (server.shouldJoinChannelsIfNoUsers()) {
        return store.rooms.getTrackedChannelsForServer(server.domain);
    }
    else {
        return membershiplists.getChannelsToJoin(server);
    }
};

var loginToServer = function(server) {
    var uname = "matrixirc";
    var bridgedClient = module.exports.getIrcUserFromCache(server, uname);
    if (!bridgedClient) {
        var ircUser = server.createBotIrcUser();
        ircUser.username = uname;
        bridgedClient = pool.createIrcClient(ircUser, null, true);
        log.debug(
            "Created new bot client for %s : %s", server.domain, bridgedClient._id
        );
    }
    var chansToJoin = [];
    return getChannelsToJoin(server).then(function(channels) {
        log.info("Bot connecting to %s (%s channels) => %s",
            server.domain, (channels ? channels.length : "0"),
            JSON.stringify(channels)
        );
        chansToJoin = channels;
        return bridgedClient.connect(globalHooks);
    }).then(function(client) {
        pool.addBot(server, bridgedClient);
        var num = 1;
        chansToJoin.forEach(function(c) {
            // join a channel every 500ms. We stagger them like this to
            // avoid thundering herds
            setTimeout(function() {
                bridgedClient.joinChannel(c);
            }, 500 * num);
            num += 1;
        });
    },
    function(err) {
        log.error("Bot failed to connect to %s : %s - Retrying....",
            server.domain, JSON.stringify(err));
        log.logErr(err);
        return loginToServer(server);
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

module.exports.getBridgedClientsForUserId = function(userId) {
    return pool.getBridgedClientsForUserId(userId);
};

module.exports.isNickVirtualUser = function(server, nick) {
    var isVirtualIrcClient = (
        pool.getBridgedClientByNick(server, nick) !== undefined
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

module.exports.getCachedBridgedClient = function(ircUser) {
    if (!ircUser) {
        return;
    }
    return pool.getBridgedClientByNick(ircUser.server, ircUser.nick);
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
