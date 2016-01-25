/*
 * Main entry point for this service.
 */
"use strict";

module.exports.serviceName = "matrix-appservice-irc";

var promiseutil = require("./promiseutil");

var matrixToIrc = require("./bridge/matrix-to-irc.js");
var ircToMatrix = require("./bridge/irc-to-matrix.js");
var membershiplists = require("./bridge/membershiplists.js");
var IrcServer = require("./irclib/server.js").IrcServer;
var ircLib = require("./irclib/irc.js");
var matrixLib = require("./mxlib/matrix");
var MatrixUser = require("./models/users").MatrixUser;
var store = require("./store");
var stats = require("./config/stats");
var ident = require("./irclib/ident");
var names = require("./irclib/names");
var logging = require("./logging");
var log = logging.get("main");

var servers = [];
var dbConnPromise = null;

module.exports.configure = function(config) {
    if (config.logging) {
        logging.configure(config.logging);
        logging.setUncaughtExceptionLogger(log);
    }
    if (config.statsd.hostname) {
        stats.setEndpoint(config.statsd);
    }
    if (config.ident.enabled) {
        ident.configure(config.ident);
        ident.run();
    }

    dbConnPromise = store.connectToDatabase(config.databaseUri);
    dbConnPromise.then(function() {
        // blow away all the previous configuration mappings, we're setting new
        // ones now.
        return store.rooms.removeConfigMappings();
    }).catch(log.logErr);

    Object.keys(config.servers).forEach(function(domain) {
        var server = new IrcServer(domain, config.servers[domain]);
        dbConnPromise.done(function() {
            // persist the config mappings in the database just like with
            // dynamically created rooms. It's better to have all these
            // things in one place. This also lets the store return
            // IrcServer objects rather than just the server domain which is
            // stored in the database, because we're passing it through
            // here.
            store.setServerFromConfig(
                server, config.servers[domain]
            );
        });
        servers.push(server);
    });

    if (servers.length === 0) {
        throw new Error("No servers specified.");
    }
    ircLib.setServers(servers);
};

module.exports.register = function(controller, serviceConfig) {
    // set the HTTP request logger
    controller.setLogger(function(line) {
        log.info(line.replace(/\n/g, " "));
    });
    controller.setAliasQueryResolver(matrixToIrc.onAliasQuery);
    controller.setUserQueryResolver(matrixToIrc.onUserQuery);
    for (var i = 0; i < servers.length; i++) {
        var server = servers[i];
        // add an alias pattern for servers who want aliases exposed.
        if (server.createsDynamicAliases()) {
            controller.addRegexPattern(
                "aliases", server.getAliasRegex(), true
            );
        }
        controller.addRegexPattern(
            "users", server.getUserRegex(), true
        );
    }

    var defer = promiseutil.defer();
    dbConnPromise.then(function() {
        return store.rooms.getRoomIdsFromConfig();
    }).then(function(configRooms) {
        for (var roomIndex = 0; roomIndex < configRooms.length; roomIndex++) {
            controller.addRegexPattern("rooms", configRooms[roomIndex], false);
        }
        return store.config.get();
    }).done(function(info) {
        var dbToken = info ? info.hsToken : undefined;
        // if we're generating a registration, save the hs token we've been told
        // to use. If we AREN'T generating a registration, then the hs token CRC
        // should match the one in the database. If they don't, something is
        // wrong. Use the db token (since it was the generated one) rather than
        // the controller one (which is a new generated one) if they match.
        if (serviceConfig.generateRegistration) {
            // save the token
            store.config.set({
                hsToken: controller.hsToken
            }).done(function() {
                console.log("Set HS token: %s", controller.hsToken);
                defer.resolve();
            });
        }
        else {
            var delim = "_crc";
            if (!controller.hsToken ||
                    controller.hsToken.indexOf(delim) === -1) {
                console.error("No CRC found on HS token, see app.js.");
                // can't check
                defer.resolve();
            }
            else if (!dbToken) {
                // first run
                console.log("HS Token -> %s", controller.hsToken);
                defer.resolve();
            }
            else {
                var nowConfigCrc = controller.hsToken.split(delim)[1];
                var generatedConfigCrc = dbToken.split(delim)[1];
                if (nowConfigCrc !== generatedConfigCrc) {
                    console.log(
                        "HS Token mismatch! Now:%s DB:%s",
                        nowConfigCrc, generatedConfigCrc
                    );
                    if (serviceConfig.skipCrcCheck) {
                        controller.hsToken = dbToken;
                        defer.resolve();
                    }
                    else {
                        var errStr = (
                            "FATAL: The IRC service config has been modified but " +
                            "--generate-registration has not been run to update " +
                            "the home server. Aborting.\n\nTo fix this:\n" +
                            "- Run 'node app.js --generate-registration'.\n" +
                            "- Move the generated registration config to the " +
                            "homeserver.\n" +
                            "- Restart the homeserver."
                        );
                        console.log(errStr);
                        defer.reject(errStr);
                    }
                }
                else {
                    controller.hsToken = dbToken;
                    console.log("HS Token -> %s", controller.hsToken);
                    defer.resolve();
                }
            }
        }
    }, function(err) {
        defer.reject(err);
    });

    controller.on("type:m.room.message", matrixToIrc.onMessage);
    controller.on("type:m.room.topic", matrixToIrc.onMessage);
    controller.on("type:m.room.member", function(event) {
        if (!event.content || !event.content.membership) {
            return Promise.resolve();
        }
        var target = new MatrixUser(event.state_key, null, null);
        var sender = new MatrixUser(event.user_id, null, null);
        if (event.content.membership === "invite") {
            return matrixToIrc.onInvite(event, sender, target);
        }
        else if (event.content.membership === "join") {
            return matrixToIrc.onJoin(event, target);
        }
        else if (["ban", "leave"].indexOf(event.content.membership) !== -1) {
            return matrixToIrc.onLeave(event, target);
        }
    });

    var asLocalpart = serviceConfig.localpart || module.exports.serviceName;

    matrixLib.setMatrixClientConfig({
        baseUrl: serviceConfig.homeserver.url,
        accessToken: serviceConfig.appservice.token,
        domain: serviceConfig.homeserver.domain,
        localpart: asLocalpart
    });
    ircLib.registerHooks({
        onMessage: ircToMatrix.onMessage,
        onPrivateMessage: ircToMatrix.onPrivateMessage,
        onJoin: ircToMatrix.onJoin,
        onPart: ircToMatrix.onPart,
        onMode: ircToMatrix.onMode
    });
    if (!serviceConfig.generateRegistration) {
        log.info("Joining mapped Matrix rooms...");
        matrixLib.joinMappedRooms().then(function() {
            log.info("Connecting to IRC networks...");
            return ircLib.connect();
        }).done(function() {
            log.info("Syncing relevant membership lists...");
            servers.forEach(function(svr) {
                membershiplists.sync(svr);
            });
        });
    }
    names.initQueue();

    return defer.promise;
};
