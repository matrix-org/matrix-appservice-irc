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
var logging = require("./logging");
var log = logging.get("main");

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
    if (opts.logging) {
        logging.configure(opts.logging);
    }

    dbConnPromise = store.connectToDatabase(opts.databaseUri);
    dbConnPromise.then(function() {
        // blow away all the previous configuration mappings, we're setting new
        // ones now.
        return store.removeConfigMappings();
    });

    if (opts.servers) {
        var serverDomains = Object.keys(opts.servers);
        serverDomains.forEach(function(domain) {
            var server = new IrcServer(domain, opts.servers[domain]);
            dbConnPromise.done(function() {
                // persist the config mappings in the database just like with
                // dynamically created rooms. It's better to have all these 
                // things in one place. This also lets the store return 
                // IrcServer objects rather than just the server domain which is
                // stored in the database, because we're passing it through 
                // here.
                store.setServerFromConfig(
                    server, opts.servers[domain]
                );
            });
            servers.push(server);
        });
    }
    if (servers.length == 0) {
        throw new Error("No servers specified.");
    }
    ircLib.setServers(servers);
};

module.exports.register = function(controller, serviceConfig) {
    controller.setLogger(function(line) {
        log.info(line.replace(/\n/g, " "));
    });
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

    // we need to see if we need to register with the HS. We do this by checking
    // if we've registered before, hence waiting on the database.
    var defer = q.defer();
    dbConnPromise.then(function() {
        return store.getRegistrationInfo();
    }).then(function(info) {
        // if we've already registered the regex we've just configured, just set
        // the token to prevent re-registering and resolve the call.
        // TODO: String comparisons like this make me sad: can we guarantee that
        // keys will be ordered in the same way?
        if (info && JSON.stringify(info.namespaces) === 
                JSON.stringify(controller.getRegexNamespaces())) {
            controller.setHomeserverToken(info.hsToken);
        }
        return store.getRoomIdConfigs();
    }).done(function(configRooms) {
        for (var i=0; i<configRooms.length; i++) {
            controller.addRegexPattern("rooms", configRooms[i], false);
        }
        defer.resolve();
    }, function(err) {
        defer.reject(err);
    });

    controller.on("type:m.room.message", bridge.hooks.matrix.onMessage);
    controller.on("type:m.room.topic", bridge.hooks.matrix.onMessage);
    controller.on("type:m.room.member", function(event) {
        if (event.content && event.content.membership === "invite") {
            bridge.hooks.matrix.onInvite(event);
        }
    });
    controller.on("registered", function(registrationInfo) {
        dbConnPromise.done(function() {
            store.setRegistrationInfo(registrationInfo).done(function() {

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