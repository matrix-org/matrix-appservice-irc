/*
 * Public API for interacting with IRC.
 */
"use strict";
var q = require("q");
var log = require("../logging").get("irc");

var pool = require("./server-pool");
var roomModels = require("../models/rooms");
var users = require("../models/users");
var requests = require("../models/requests");
var store = require("../store");
var VirtualIrcUser = require("./client").VirtualIrcUser;
var protocols = require("../protocols");
var PROTOCOLS = protocols.PROTOCOLS;

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
        log.error("Failed to connect to %s : %s", 
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

var sendBotText = function(server, channel, text) {
    var defer = q.defer();
    getBotClient(server).done(function(client) {
        client.say(channel, text);
        defer.resolve();
    });
    return defer.promise;
};

module.exports.checkNickExists = function(server, nick) {
    var defer = q.defer();
    log.info("Querying for nick %s on %s", nick, server.domain);
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
        return q.reject(requests.ERR_VIRTUAL_USER);
    }

    var virtualUser = pool.getExistingVirtualUserByUserId(server, userId);
    if (virtualUser) {
        return q(virtualUser);
    }

    var defer = q.defer();

    var nick = createIrcNickForMatrixUserId(userId);
    var ircUser = users.irc.createUser(server, nick, true);
    virtualUser = new VirtualIrcUser(ircUser, userId);
    virtualUser.connect(globalHooks).done(function() {
        pool.storeVirtualUser(virtualUser);
        defer.resolve(virtualUser);
    },
    function(err) {
        log.error("Couldn't connect virtual user %s to %s : %s",
            nick, server.domain, JSON.stringify(err))
        defer.reject(err);
    });

    return defer.promise;
};

module.exports.isNickVirtualUser = function(server, nick) {
    return pool.getExistingVirtualUserByNick(server, nick) !== undefined;
};

module.exports.getVirtualUser = function(ircUser) {
    if (!ircUser) {
        return;
    }
    return pool.getExistingVirtualUserByNick(ircUser.server, ircUser.nick);
};

module.exports.trackChannel = function(server, channel) {
    var defer = q.defer();
    getBotClient(server).then(function(client) {
        client.join(channel, function() {
            var room = roomModels.irc.createRoom(server, channel);
            defer.resolve(room);
        });
    }, function(err) {
        defer.reject(err);
    });
    return defer.promise;
};

module.exports.sendAction = function(ircRoom, virtualIrcUser, action) {
    if (action.sender === "bot") {
        if (!action.text) {
            return q.reject("Sender is 'bot' but no text to say!");
        }
        // modify the text to put in the sender
        if (action.action === "image") {
            action.text = "<"+virtualIrcUser.nick+"> posted an image: "+
                          action.text;
        }
        return sendBotText(ircRoom.server, ircRoom.channel, action.text);
    }
    else {
        return virtualIrcUser.sendAction(ircRoom, action);
    }
};

module.exports.getServers = function() {
    return servers;
};

var createIrcNickForMatrixUserId = function(userId) {
    // TODO handle nick clashes.
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

var userIdToServerNick = function(userId) {
    var server = getServerForUserId(userId, servers);
    if (!server) {
        return {};
    }
    var nick = getNickForUserId(server, userId);
    return {
        server: server,
        nick: nick
    };
};

var getServerForAlias = function(alias, servers) {
    for (var i=0; i<servers.length; i++) {
        var server = servers[i];
        if (alias.indexOf("#"+server.aliasPrefix) === 0) {
            return server;
        }
    }
};

var getChannelForAlias = function(server, alias) {
    if (alias.indexOf("#"+server.aliasPrefix) !== 0) {
        return;
    }
    var chanAndDomain = alias.substring(("#"+server.aliasPrefix).length);
    if (chanAndDomain.indexOf("#") !== 0) {
        return; // not a channel.
    }
    return chanAndDomain.split(":")[0];
};

protocols.setMapperToIrc("aliases", function(alias) {
    var server = getServerForAlias(alias, servers);
    if (!server) {
        return {};
    }
    var channel = getChannelForAlias(server, alias);
    return {
        server: server,
        channel: channel
    };
});

protocols.setMapperToIrc("users", function(user) {
    if (user.protocol !== PROTOCOLS.MATRIX) {
        log.error("Bad src protocol: %s", user.protocol);
        return q.reject("Bad source protocol.");
    }
    var ircInfo = userIdToServerNick(user.userId);
    if (!ircInfo.server || !ircInfo.nick) {
        return q.reject("User ID "+user.userId+" doesn't map to a server/nick");
    }
    return q(users.irc.createUser(ircInfo.server, ircInfo.nick, true));
});