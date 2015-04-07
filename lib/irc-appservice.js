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
        databaseUri: "nedb://databasename",
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

    var defer = q.defer();
    dbConnPromise.then(function() {
        return store.getRoomIdConfigs();
    }).then(function(configRooms) {
        for (var i=0; i<configRooms.length; i++) {
            controller.addRegexPattern("rooms", configRooms[i], false);
        }
        return store.getRegistrationInfo();
    }).done(function(info) {
        var dbToken = info ? info.hsToken : undefined;
        // if we're generating a registration, save the hs token we've been told
        // to use. If we AREN'T generating a registration, then the hs token CRC
        // should match the one in the database. If they don't, something is
        // wrong. Use the db token (since it was the generated one) rather than
        // the controller one (which is a new generated one) if they match.
        if (serviceConfig.generateRegistration) {
            // save the token
            store.setRegistrationInfo({
                hsToken: controller.hsToken
            }).done(function() {
                console.log("Set HS token: %s", controller.hsToken);
                defer.resolve();
            });
        }
        else {
            var delim = "_crc";
            if (!controller.hsToken || controller.hsToken.indexOf(delim) === -1) {
                console.error("No CRC found on HS token, see app.js.");
                // can't check
                defer.resolve();
            }
            else if (!dbToken) {
                // first run
                console.log("HS Token -> %s",controller.hsToken);
                defer.resolve();
            }
            else {
                var nowConfigCrc = controller.hsToken.split(delim)[1];
                var generatedConfigCrc = dbToken.split(delim)[1];
                if (nowConfigCrc !== generatedConfigCrc) {
                    defer.reject(
                        "FATAL: The IRC service config has been modified but "+
                        "--generate-registration has not been run to update "+
                        "the home server. Aborting.\n\nTo fix this:\n"+
                        "- Run 'node app.js --generate-registration'.\n"+
                        "- Move the generated registration config to the homeserver.\n"+
                        "- Restart the homeserver."
                    );
                }
                else {
                    controller.hsToken = dbToken;
                    console.log("HS Token -> %s",controller.hsToken);
                    defer.resolve();
                }
            }
        }
    }, function(err) {
        defer.reject(err);
    });

    controller.on("type:m.room.message", bridge.hooks.matrix.onMessage);
    controller.on("type:m.room.topic", bridge.hooks.matrix.onMessage);
    controller.on("type:m.room.member", function(event) {
        if (event.content && event.content.membership === "invite") {
            return bridge.hooks.matrix.onInvite(event);
        }
    });

    var appServLocalpart = serviceConfig.localpart || module.exports.serviceName;

    matrixLib.setMatrixClientConfig({
        baseUrl: serviceConfig.hs,
        accessToken: serviceConfig.token,
        domain: serviceConfig.hsDomain,
        localpart: appServLocalpart
    });
    ircLib.registerHooks({
        onMessage: bridge.hooks.irc.onMessage
    });
    if (!serviceConfig.generateRegistration) {
        ircLib.connect();
    }

    return defer.promise;
};