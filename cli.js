"use strict";
var Promise = require("bluebird");
var extend = require("extend");

var Cli = require("matrix-appservice-bridge").Cli;
var AppServiceRegistration = require("matrix-appservice-bridge").AppServiceRegistration;
var AppService = require("matrix-appservice").AppService;

var membershiplists = require("./lib/bridge/membershiplists.js");
var IrcServer = require("./lib/irclib/server.js").IrcServer;
var ircLib = require("./lib/irclib/irc.js");
var matrixLib = require("./lib/mxlib/matrix");
var MatrixUser = require("./lib/models/users").MatrixUser;
var store = require("./lib/store");
var stats = require("./lib/config/stats");
var ident = require("./lib/irclib/ident");
var names = require("./lib/irclib/names");
var logging = require("./lib/logging");
var log = logging.get("main");

const DEFAULT_LOCALPART = "appservice-irc";
const REG_PATH = "appservice-registration-irc.yaml";

var _toServer = function(domain, serverConfig) {
    // set server config defaults
    var defaultServerConfig = {
        botConfig: {
            nick: "appservicebot",
            joinChannelsIfNoUsers: true,
            enabled: true
        },
        privateMessages: {
            enabled: true,
            exclude: []
        },
        dynamicChannels: {
            enabled: false,
            published: true,
            createAlias: true,
            joinRule: "public",
            federate: true,
            aliasTemplate: "#irc_$SERVER_$CHANNEL",
            whitelist: [],
            exclude: []
        },
        mappings: {},
        matrixClients: {
            userTemplate: "@$SERVER_$NICK",
            displayName: "$NICK (IRC)"
        },
        ircClients: {
            nickTemplate: "M-$DISPLAY",
            maxClients: 30,
            idleTimeout: 172800,
            allowNickChanges: false
        },
        membershipLists: {
            enabled: false,
            global: {
                ircToMatrix: {
                    initial: false,
                    incremental: false
                },
                matrixToIrc: {
                    initial: false,
                    incremental: false
                }
            },
            channels: [],
            rooms: []
        }
    };
    if (serverConfig.dynamicChannels.visibility) {
        throw new Error(
            `[DEPRECATED] Use of the config field dynamicChannels.visibility
            is deprecated. Use dynamicChannels.published, dynamicChannels.joinRule
            and dynamicChannels.createAlias instead.`
        );
    }
    return new IrcServer(domain, extend(true, defaultServerConfig, serverConfig));
};

var _generateRegistration = Promise.coroutine(function*(reg, config) {
    if (config.appService) {
        throw new Error(
            `[DEPRECATED] Use of config field 'appService' is deprecated. Delete this entire object and try again.
            It has been replaced with the field 'registrationFile' which points to the location
            of the registration file generated earlier with the CLI flag -r. The port
            can be changed using the CLI flag -p. Type --help for more information.`
        );
    }

    reg.setHomeserverToken(AppServiceRegistration.generateToken());
    reg.setAppServiceToken(
        config.appService.appservice.token || AppServiceRegistration.generateToken()
    );
    reg.setSenderLocalpart(config.appService.localpart || DEFAULT_LOCALPART);

    let serverDomains = Object.keys(config.ircService.servers);
    for (var i = 0; i < serverDomains.length; i++) {
        let domain = serverDomains[i];
        let server = _toServer(domain, config.ircService.servers[domain]);
        server.getHardCodedRoomIds().forEach(function(roomId) {
            reg.addRegexPattern("rooms", roomId, false);
        });
        // add an alias pattern for servers who want aliases exposed.
        if (server.createsDynamicAliases()) {
            reg.addRegexPattern("aliases", server.getAliasRegex(), true);
        }
        reg.addRegexPattern("users", server.getUserRegex(), true);
    }

    return reg;
});

var _runBridge = Promise.coroutine(function*(port, config) {
    if (config.ircService.logging) {
        logging.configure(config.ircService.logging);
        logging.setUncaughtExceptionLogger(log);
    }
    if (config.ircService.statsd.hostname) {
        stats.setEndpoint(config.ircService.statsd);
    }
    if (config.ircService.ident.enabled) {
        ident.configure(config.ircService.ident);
        ident.run();
    }

    yield store.connectToDatabase(config.ircService.databaseUri);
    // blow away all the previous configuration mappings, we're setting new ones now.
    yield store.rooms.removeConfigMappings();

    let servers = [];
    let serverDomains = Object.keys(config.ircService.servers);
    for (var i = 0; i < serverDomains.length; i++) {
        let domain = serverDomains[i];
        let server = _toServer(domain, config.ircService.servers[domain]);
        yield store.setServerFromConfig(server, config.ircService.servers[domain]);
        servers.push(server);
    }

    if (servers.length === 0) {
        throw new Error("No servers specified.");
    }


    // configure IRC side
    var ircToMatrix = require("./bridge/irc-to-matrix.js");
    ircLib.registerHooks({
        onMessage: ircToMatrix.onMessage,
        onPrivateMessage: ircToMatrix.onPrivateMessage,
        onJoin: ircToMatrix.onJoin,
        onPart: ircToMatrix.onPart,
        onMode: ircToMatrix.onMode
    });
    ircLib.setServers(servers);
    names.initQueue();


    // configure Matrix side
    var matrixToIrc = require("./bridge/matrix-to-irc.js");
    var appService = new AppService();
    appService.on("http-log", function(logLine) {
        log.info(logLine.replace(/\n/g, " "));
    });
    appService.on("type:m.room.message", matrixToIrc.onMessage);
    appService.on("type:m.room.topic", matrixToIrc.onMessage);
    appService.on("type:m.room.member", function(event) {
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
    matrixLib.setMatrixClientConfig({
        baseUrl: config.appService.homeserver.url,
        accessToken: config.appService.appservice.token,
        domain: config.appService.homeserver.domain,
        localpart: config.appService.localpart || DEFAULT_LOCALPART
    });


    // Start things
    log.info("Joining mapped Matrix rooms...");
    yield matrixLib.joinMappedRooms();
    log.info("Connecting to IRC networks...");
    yield ircLib.connect();
    log.info("Syncing relevant membership lists...");
    for (var i = 0; i < servers.length; i++) {
        yield membershiplists.sync(servers[i]);
    };
});


new Cli({
    registrationPath: REG_PATH,
    bridgeConfig: {
        affectsRegistration: true,
        schema: "./lib/config/schema.yml",
        defaults: {
            ircService: {
                ident: {
                    enabled: false,
                    port: 113
                },
                logging: {
                    level: "debug",
                    toConsole: true
                },
                statsd: {}
            }
        }
    },
    generateRegistration: function(reg, callback) {
        _generateRegistration(reg, this.getConfig()).done(function(completeRegistration) {
            console.log(`Output registration to: ${REG_PATH}`);
            callback(completeRegistration);
        });
    },
    run: function(port, config) {
        _runBridge(port, config).catch(function(err) {
            console.error("Failed to run bridge.");
            throw err;
        });
    }
}).run();
