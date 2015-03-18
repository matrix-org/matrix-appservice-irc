/*
 * Main entry point for this service.
 */
"use strict";
module.exports.serviceName = "matrix-appservice-irc";

var q = require("q");
var bridge = require("./bridge.js");
var IrcServer = require("./irclib/server.js").IrcServer;
var ircLib = require("./irclib/irc.js");
var matrixLib = require("./mxlib/matrix");
var store = require("./store");

var servers = [];
var dbConnPromise = null;

module.exports.configure = function(opts) {
    /*
    Format:
    {
        databaseUri: "mongodb://localhost/databasename",
        servers: {
            "server.domain.com": {
                nick: "BotNick",
                expose: {
                    channels: true,
                    privateMessages: false
                },
                rooms: {
                    mappings: {
                        "#specific-channel": ["!room1:matrix.org", "!room2:matrix.org"],
                    },
                    aliasPrefix: "#irc_",
                    exclude: [ "#foo", "#bar" ]
                }
            },
            "another.server.com": {
                ...
            }
        }
    }
    */
    dbConnPromise = store.connectToDatabase(opts.databaseUri);

    if (opts.servers) {
        var serverDomains = Object.keys(opts.servers);
        for (var i=0; i<serverDomains.length; i++) {
            var server = new IrcServer(
                serverDomains[i], opts.servers[serverDomains[i]]
            );
            bridge.store.setRoomsFromConfig(
                server, opts.servers[serverDomains[i]]
            );
            servers.push(server);
        }
    }
    if (servers.length == 0) {
        throw new Error("No servers specified.");
    }
    ircLib.setServers(servers);
};

module.exports.register = function(controller, serviceConfig) {
    controller.setAliasQueryResolver(bridge.hooks.matrix.onAliasQuery);
    controller.setUserQueryResolver(bridge.hooks.matrix.onUserQuery);
    for (var i=0; i<servers.length; i++) {
        var server = servers[i];
        if (server.shouldMapAllRooms()) {
            controller.addRegexPattern(
                "aliases", "#"+server.aliasPrefix+".*", true
            );
        }
        controller.addRegexPattern(
            "users", "@"+server.userPrefix+".*", true
        );
    }

    var defer = q.defer();

    dbConnPromise.then(function() {
        return store.getRegistrationInfo();
    }).done(function(info) {
        // if we've already registered the regex we've just configured, just set
        // the token to prevent re-registering and resolve the call.
        // TODO: String comparisons like this make me sad: can we guarantee that
        // keys will be ordered in the same way?
        if (info && JSON.stringify(info.namespaces) === 
                JSON.stringify(controller.getRegexNamespaces())) {
            controller.setHomeserverToken(info.hsToken);
        }
        defer.resolve();
    }, function(err) {
        defer.reject(err);
    });

    controller.on("type:m.room.message", bridge.hooks.matrix.onMessage);
    controller.on("type:m.room.member", function(event) {
        if (event.content && event.content.membership === "invite") {
            bridge.hooks.matrix.onInvite(event);
        }
    });
    controller.on("registered", function(registrationInfo) {
        dbConnPromise.done(function() {
            store.setRegistrationInfo(registrationInfo).done(function() {
                console.log("Stored registration info.");
            });
        }) // hard fail if not connected
    });
    matrixLib.setMatrixClientConfig({
        baseUrl: serviceConfig.hs,
        accessToken: serviceConfig.token,
        domain: serviceConfig.hsDomain
    });
    ircLib.registerHooks({
        onMessage: bridge.hooks.irc.onMessage
    });
    ircLib.connect();

    return defer.promise;
};