"use strict";
var Promise = require("bluebird");
var extend = require("extend");

var Cli = require("matrix-appservice-bridge").Cli;
var AppServiceRegistration = require("matrix-appservice-bridge").AppServiceRegistration;
var AppService = require("matrix-appservice").AppService;

var ircToMatrix = require("./lib/bridge/irc-to-matrix.js");
var matrixToIrc = require("./lib/bridge/matrix-to-irc.js");
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
    var asToken;
    if (config.appService) {
        console.warn(
            `[DEPRECATED] Use of config field 'appService' is deprecated. Remove this field from the config file to remove this warning.

            This release will use values from this config file. This will produce a fatal error in a later release.

            The new format looks like:
            homeserver:
                url: "https://home.server.url"
                domain: "home.server.url"

            The new locations for the missing fields are as follows:
            http.port - Passed as a CLI flag --port.
            appservice.token - Automatically generated.
            appservice.url - Passed as a CLI flag --url
            localpart - Passed as a CLI flag --localpart
            `
        );
        if (config.appService.localpart) {
            console.log("NOTICE: Using localpart from config file");
            reg.setSenderLocalpart(config.appService.localpart);
        }
        asToken = config.appService.appservice.token;
    }

    if (!reg.getSenderLocalpart()) {
        reg.setSenderLocalpart(DEFAULT_LOCALPART);
    }


    reg.setHomeserverToken(AppServiceRegistration.generateToken());
    reg.setAppServiceToken(asToken || AppServiceRegistration.generateToken());

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

var _runBridge = Promise.coroutine(function*(port, config, reg) {
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
    var appService = new AppService({
        homeserverToken: reg.getHomeserverToken()
    });
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

    if (config.appService) {
        console.warn(
            `[DEPRECATED] Use of config field 'appService' is deprecated. Remove this field from the config file to remove this warning.

            This release will use values from this config file. This will produce a fatal error in a later release.`
        );
        matrixLib.setMatrixClientConfig({
            baseUrl: config.appService.homeserver.url,
            accessToken: config.appService.appservice.token,
            domain: config.appService.homeserver.domain,
            localpart: config.appService.localpart || DEFAULT_LOCALPART
        });
    }
    else {
        if (!reg.getSenderLocalpart() || !reg.getAppServiceToken()) {
            throw new Error("FATAL: Registration file is missing a sender_localpart and/or AS token.");
        }
        matrixLib.setMatrixClientConfig({
            baseUrl: config.homeserver.url,
            accessToken: reg.getAppServiceToken(),
            domain: config.homeserver.domain,
            localpart: reg.getSenderLocalpart()
        });
    }

    // Start things
    log.info("Joining mapped Matrix rooms...");
    yield matrixLib.joinMappedRooms();
    log.info("Connecting to IRC networks...");
    yield ircLib.connect();
    log.info("Syncing relevant membership lists...");
    for (var i = 0; i < servers.length; i++) {
        membershiplists.sync(servers[i]);
    };
    appService.listen(port);
});


new Cli({
    registrationPath: REG_PATH,
    enableRegistration: true,
    enableLocalpart: true,
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
            callback(completeRegistration);
        });
    },
    run: function(port, config, reg) {
        _runBridge(port, config, reg).catch(function(err) {
            console.error("Failed to run bridge.");
            throw err;
        });
    }
}).run();
