/*eslint no-invalid-this: 0*/ // eslint doesn't understand Promise.coroutine wrapping
"use strict";
var Promise = require("bluebird");
var extend = require("extend");

var promiseutil = require("../promiseutil");
var IrcHandler = require("./IrcHandler.js");
var MatrixHandler = require("./MatrixHandler.js");
var MemberListSyncer = require("./MemberListSyncer.js");
var IdentGenerator = require("../irc/IdentGenerator.js");
var Ipv6Generator = require("../irc/Ipv6Generator.js");
var IrcServer = require("../irc/IrcServer.js");
var ClientPool = require("../irc/ClientPool");
var IrcEventBroker = require("../irc/IrcEventBroker");
var BridgedClient = require("../irc/BridgedClient");
var IrcUser = require("../models/IrcUser");
var IrcRoom = require("../models/IrcRoom");
var IrcClientConfig = require("../models/IrcClientConfig");
var BridgeRequest = require("../models/BridgeRequest");
var stats = require("../config/stats");
var DataStore = require("../DataStore");
var log = require("../logging").get("IrcBridge");
const { Bridge, MatrixUser, PrometheusMetrics, Logging } = require("matrix-appservice-bridge");
var DebugApi = require("../DebugApi");
var Provisioner = require("../provisioning/Provisioner.js");
var PublicitySyncer = require("./PublicitySyncer.js");

const DELAY_TIME_MS = 10 * 1000;
const DELAY_FETCH_ROOM_LIST_MS = 3 * 1000;
const DEAD_TIME_MS = 5 * 60 * 1000;
const ACTION_TYPE_TO_MSGTYPE = {
    message: "m.text",
    emote: "m.emote",
    notice: "m.notice"
};

function IrcBridge(config, registration) {
    this.config = config;
    // TODO: Don't log this to stdout
    Logging.configure({console: config.ircService.logging.level});
    this.registration = registration;
    this.ircServers = [];
    this.domain = null; // String
    this.appServiceUserId = null; // String
    this.memberListSyncers = {
    //  domain: MemberListSyncer
    };
    this.joinedRoomList = [];

    // Dependency graph
    this.matrixHandler = new MatrixHandler(this, this.config.matrixHandler);
    this.ircHandler = new IrcHandler(this, this.config.ircHandler);
    this._clientPool = new ClientPool(this);
    var dirPath = this.config.ircService.databaseUri.substring("nedb://".length);
    let roomLinkValidation = undefined;
    let provisioning = config.ircService.provisioning;
    if (provisioning && provisioning.enabled &&
        typeof (provisioning.ruleFile) === "string") {
        roomLinkValidation = {
            ruleFile: provisioning.ruleFile,
            triggerEndpoint: provisioning.enableReload
        };
    }

    this._bridge = new Bridge({
        registration: this.registration,
        homeserverUrl: this.config.homeserver.url,
        domain: this.config.homeserver.domain,
        controller: {
            onEvent: this.onEvent.bind(this),
            onUserQuery: this.onUserQuery.bind(this),
            onAliasQuery: this.onAliasQuery.bind(this),
            onAliasQueried: this.onAliasQueried ?
                this.onAliasQueried.bind(this) : null,
            onLog: this.onLog.bind(this),

            thirdPartyLookup: {
                protocols: ["irc"],
                getProtocol: this.getThirdPartyProtocol.bind(this),
                getLocation: this.getThirdPartyLocation.bind(this),
                getUser: this.getThirdPartyUser.bind(this),
            },
        },
        roomStore: dirPath + "/rooms.db",
        userStore: dirPath + "/users.db",
        disableContext: true,
        suppressEcho: false, // we use our own dupe suppress for now
        logRequestOutcome: false, // we use our own which has better logging
        queue: {
            type: "none",
            perRequest: false
        },
        intentOptions: {
            clients: {
                dontCheckPowerLevel: true,
                enablePresence: this.config.homeserver.enablePresence,
            },
            bot: {
                dontCheckPowerLevel: true,
                enablePresence: this.config.homeserver.enablePresence,
            }
        },
        // See note below for ESCAPE_DEFAULT
        escapeUserIds: false,
        roomLinkValidation,
        roomUpgradeOpts: {
            consumeEvent: true,
            // We want to handle this in _onRoomUpgrade
            migrateGhosts: false,
            onRoomMigrated: this._onRoomUpgrade.bind(this),
        }
    });

    // By default the bridge will escape mxids, but the irc bridge isn't ready for this yet.
    MatrixUser.ESCAPE_DEFAULT = false;

    this._timers = null; // lazy map of Histogram instances used as metrics
    if (this.config.ircService.metrics && this.config.ircService.metrics.enabled) {
        this._initialiseMetrics();
    }

    this._ircEventBroker = new IrcEventBroker(
        this._bridge, this._clientPool, this.ircHandler
    );
    this._dataStore = null; // requires Bridge to have loaded the databases
    this._identGenerator = null; // requires inited data store
    this._ipv6Generator = null; // requires inited data store
    this._startedUp = false;
    this._debugApi = (
        config.ircService.debugApi.enabled ? new DebugApi(
            this,
            config.ircService.debugApi.port,
            this.ircServers,
            this._clientPool,
            registration.getAppServiceToken()
        ) : null
    );

    this._provisioner = null;

    this.publicitySyncer = new PublicitySyncer(this);
}

IrcBridge.prototype._initialiseMetrics = function() {
    const zeroAge = new PrometheusMetrics.AgeCounters();

    const metrics = this._bridge.getPrometheusMetrics();

    this._bridge.registerBridgeGauges(() => {
        const remoteUsersByAge = new PrometheusMetrics.AgeCounters(
            this.config.ircService.metrics.remoteUserAgeBuckets || ["1h", "1d", "1w"]
        );

        this.ircServers.forEach((server) => {
            this._clientPool.updateActiveConnectionMetrics(server.domain, remoteUsersByAge);
        });

        return {
            // TODO(paul): actually fill these in
            matrixRoomConfigs: 0,
            remoteRoomConfigs: 0,

            remoteGhosts: this._clientPool.countTotalConnections(),
            // matrixGhosts is provided automatically by the bridge

            // TODO(paul) IRC bridge doesn't maintain mtimes at the moment.
            //   Should probably make these metrics optional to most
            //   exporters
            matrixRoomsByAge: zeroAge,
            remoteRoomsByAge: zeroAge,

            matrixUsersByAge: zeroAge,
            remoteUsersByAge,
        };
    });

    const timers = this._timers = {};

    timers.matrix_request_seconds = metrics.addTimer({
        name: "matrix_request_seconds",
        help: "Histogram of processing durations of received Matrix messages",
        labels: ["outcome"],
    });
    timers.remote_request_seconds = metrics.addTimer({
        name: "remote_request_seconds",
        help: "Histogram of processing durations of received remote messages",
        labels: ["outcome"],
    });

    // Custom IRC metrics
    const reconnQueue = metrics.addGauge({
        name: "clientpool_reconnect_queue",
        help: "Number of disconnected irc connections waiting to reconnect.",
        labels: ["server"]
    });

    const memberListLeaveQueue = metrics.addGauge({
        name: "user_leave_queue",
        help: "Number of leave requests queued up for virtual users on the bridge.",
        labels: ["server"]
    });

    const memberListJoinQueue = metrics.addGauge({
        name: "user_join_queue",
        help: "Number of join requests queued up for virtual users on the bridge.",
        labels: ["server"]
    });

    const ircHandlerCalls = metrics.addCounter({
        name: "irchandler_calls",
        help: "Track calls made to the IRC Handler",
        labels: ["method"]
    });

    const matrixHandlerConnFailureKicks = metrics.addCounter({
        name: "matrixhandler_connection_failure_kicks",
        help: "Track IRC connection failures resulting in kicks",
        labels: ["server"]
    });

    metrics.addCollector(() => {
        this.ircServers.forEach((server) => {
            reconnQueue.set({server: server.domain},
                this._clientPool.totalReconnectsWaiting(server.domain)
            );
            let mxMetrics = this.matrixHandler.getMetrics(server.domain);
            matrixHandlerConnFailureKicks.inc(
                {server: server.domain},
                mxMetrics["connection_failure_kicks"] || 0
            );
        });

        Object.keys(this.memberListSyncers).forEach((server) => {
            memberListLeaveQueue.set(
                {server},
                this.memberListSyncers[server].getUsersWaitingToLeave()
            );
            memberListJoinQueue.set(
                {server},
                this.memberListSyncers[server].getUsersWaitingToJoin()
            );
        });

        const ircMetrics = this.ircHandler.getMetrics();
        Object.keys(ircMetrics).forEach((method) => {
            const value = ircMetrics[method];
            ircHandlerCalls.inc({method}, value);
        });
    });
};

IrcBridge.prototype.getAppServiceUserId = function() {
    return this.appServiceUserId;
};

IrcBridge.prototype.getStore = function() {
    return this._dataStore;
};

IrcBridge.prototype.getAppServiceBridge = function() {
    return this._bridge;
};

IrcBridge.prototype.getClientPool = function() {
    return this._clientPool;
};

IrcBridge.prototype.getProvisioner = function() {
    return this._provisioner;
};

IrcBridge.prototype.createBridgedClient = function(ircClientConfig, matrixUser, isBot) {
    let server = this.ircServers.filter((s) => {
        return s.domain === ircClientConfig.getDomain();
    })[0];
    if (!server) {
        throw new Error(
            "Cannot create bridged client for unknown server " +
            ircClientConfig.getDomain()
        );
    }

    return new BridgedClient(
        server, ircClientConfig, matrixUser, isBot,
        this._ircEventBroker, this._identGenerator, this._ipv6Generator
    );
};

IrcBridge.prototype.run = Promise.coroutine(function*(port) {
    yield this._bridge.loadDatabases();

    if (this._debugApi) {
        // monkey patch inspect() values to avoid useless NeDB
        // struct spam on the debug API.
        this._bridge.getUserStore().inspect = function(depth) {
            return "UserStore";
        }
        this._bridge.getRoomStore().inspect = function(depth) {
            return "RoomStore";
        }
        this._debugApi.run();
    }

    let pkeyPath = this.config.ircService.passwordEncryptionKeyPath;

    this._dataStore = new DataStore(
        this._bridge.getUserStore(), this._bridge.getRoomStore(), pkeyPath,
        this.config.homeserver.domain
    );
    yield this._dataStore.removeConfigMappings();
    this._identGenerator = new IdentGenerator(this._dataStore);
    this._ipv6Generator = new Ipv6Generator(this._dataStore);

    // maintain a list of IRC servers in-use
    let serverDomains = Object.keys(this.config.ircService.servers);
    for (var i = 0; i < serverDomains.length; i++) {
        let domain = serverDomains[i];
        let completeConfig = extend(
            true, {}, IrcServer.DEFAULT_CONFIG, this.config.ircService.servers[domain]
        );
        let server = new IrcServer(
            domain, completeConfig, this.config.homeserver.domain,
            this.config.homeserver.dropMatrixMessagesAfterSecs
        );
        // store the config mappings in the DB to keep everything in one place.
        yield this._dataStore.setServerFromConfig(server, completeConfig);
        this.ircServers.push(server);
    }

    if (this.ircServers.length === 0) {
        throw new Error("No IRC servers specified.");
    }

    // run the bridge (needs to be done prior to configure IRC side)
    yield this._bridge.run(port);
    this._addRequestCallbacks();

    if (this.config.appService) {
        console.warn(
            `[DEPRECATED] Use of config field 'appService' is deprecated. Remove this
            field from the config file to remove this warning.

            This release will use values from this config field. This will produce
            a fatal error in a later release.`
        );
        this.domain = this.config.appService.homeserver.domain;
        this.appServiceUserId = (
            "@" + (
                this.config.appService.localpart ||
                this.registration.getSenderLocalpart() ||
                IrcBridge.DEFAULT_LOCALPART
            ) + ":" +
            this.domain
        );
    }
    else {
        if (!this.registration.getSenderLocalpart() ||
                !this.registration.getAppServiceToken()) {
            throw new Error(
                "FATAL: Registration file is missing a sender_localpart and/or AS token."
            );
        }
        this.domain = this.config.homeserver.domain;
        this.appServiceUserId = (
            "@" + this.registration.getSenderLocalpart() + ":" +
            this.domain
        );
    }

    log.info("Fetching Matrix rooms that are already joined to...");
    yield this._fetchJoinedRooms();

    // start things going
    log.info("Joining mapped Matrix rooms...");
    yield this._joinMappedMatrixRooms();
    log.info("Syncing relevant membership lists...");
    let memberlistPromises = [];

    // HACK: Remember reconnectIntervals to put them back later
    //  If memberlist-syncing 100s of connections, the scheduler will cause massive
    //  waiting times for connections to be created.
    //  We disable this scheduling manually to allow people to send messages through
    //  quickly when starting up (effectively prioritising them). This is just the
    //  quickest way to disable scheduler.
    let reconnectIntervalsMap = Object.create(null);

    this.ircServers.forEach((server) => {

        reconnectIntervalsMap[server.domain] = server.getReconnectIntervalMs();
        server.config.ircClients.reconnectIntervalMs = 0;

        // TODO reduce deps required to make MemberListSyncers.
        // TODO Remove injectJoinFn bodge
        this.memberListSyncers[server.domain] = new MemberListSyncer(
            this, this._bridge.getBot(), server, this.appServiceUserId,
            (roomId, joiningUserId, displayName, isFrontier) => {
                var req = new BridgeRequest(
                    this._bridge.getRequestFactory().newRequest(), false
                );
                var target = new MatrixUser(joiningUserId);
                // inject a fake join event which will do M->I connections and
                // therefore sync the member list
                return this.matrixHandler.onJoin(req, {
                    event_id: "$fake:membershiplist",
                    room_id: roomId,
                    state_key: joiningUserId,
                    user_id: joiningUserId,
                    content: {
                        membership: "join",
                        displayname: displayName,
                    },
                    _injected: true,
                    _frontier: isFrontier
                }, target);
            }
        );
        memberlistPromises.push(
            this.memberListSyncers[server.domain].sync()
        );
    });

    let provisioningEnabled = this.config.ircService.provisioning.enabled;
    let requestTimeoutSeconds = this.config.ircService.provisioning.requestTimeoutSeconds;
    this._provisioner = new Provisioner(this, provisioningEnabled, requestTimeoutSeconds);

    log.info("Connecting to IRC networks...");
    yield this.connectToIrcNetworks();

    promiseutil.allSettled(this.ircServers.map((server) => {
        // Call MODE on all known channels to get modes of all channels
        return this.publicitySyncer.initModes(server);
    })).catch((err) => {
        log.error('Could not init modes for publicity syncer');
        log.error(err.stack);
    });

    yield Promise.all(memberlistPromises);

    // Reset reconnectIntervals
    this.ircServers.forEach((server) => {
        server.config.ircClients.reconnectIntervalMs = reconnectIntervalsMap[server.domain];
    });

    log.info("Startup complete.");
    this._startedUp = true;
});

IrcBridge.prototype._logMetric = function(req, outcome) {
    if (!this._timers) {
        return; // metrics are disabled
    }
    const isFromIrc = Boolean((req.getData() || {}).isFromIrc);
    const timer = this._timers[
        isFromIrc ? "remote_request_seconds" : "matrix_request_seconds"
    ];
    if (timer) {
        timer.observe({outcome: outcome}, req.getDuration() / 1000);
    }
}

IrcBridge.prototype._addRequestCallbacks = function() {
    function logMessage(req, msg) {
        const data = req.getData();
        const dir = data && data.isFromIrc ? "I->M" : "M->I";
        const duration = " (" + req.getDuration() + "ms)";
        log.info(`[${req.getId()}] [${dir}] ${msg} ${duration}`);
    }

    // SUCCESS
    this._bridge.getRequestFactory().addDefaultResolveCallback((req, res) => {
        if (res === BridgeRequest.ERR_VIRTUAL_USER) {
            logMessage(req, "IGNORE virtual user");
            return; // these aren't true successes so don't skew graphs
        }
        else if (res === BridgeRequest.ERR_NOT_MAPPED) {
            logMessage(req, "IGNORE not mapped");
            return; // these aren't true successes so don't skew graphs
        }
        else if (res === BridgeRequest.ERR_DROPPED) {
            logMessage(req, "IGNORE dropped");
            this._logMetric(req, "dropped");
            return;
        }
        logMessage(req, "SUCCESS");
        const isFromIrc = Boolean((req.getData() || {}).isFromIrc);
        stats.request(isFromIrc, "success", req.getDuration());
        this._logMetric(req, "success");
    });
    // FAILURE
    this._bridge.getRequestFactory().addDefaultRejectCallback((req) => {
        var isFromIrc = Boolean((req.getData() || {}).isFromIrc);
        logMessage(req, "FAILED");
        stats.request(isFromIrc, "fail", req.getDuration());
        this._logMetric(req, "fail");
    });
    // DELAYED
    this._bridge.getRequestFactory().addDefaultTimeoutCallback((req) => {
        logMessage(req, "DELAYED");
        var isFromIrc = Boolean((req.getData() || {}).isFromIrc);
        stats.request(isFromIrc, "delay", req.getDuration());
    }, DELAY_TIME_MS);
    // DEAD
    this._bridge.getRequestFactory().addDefaultTimeoutCallback((req) => {
        logMessage(req, "DEAD");
        var isFromIrc = Boolean((req.getData() || {}).isFromIrc);
        stats.request(isFromIrc, "fail", req.getDuration());
        this._logMetric(req, "fail");
    }, DEAD_TIME_MS);
}

// Kill the bridge by killing all IRC clients in memory.
//  Killing a client means that it will disconnect forever
//  and never do anything useful again.
//  There is no guarentee that the bridge will do anything
//  usefull once this has been called.
//
//  See (BridgedClient.prototype.kill)
IrcBridge.prototype.kill = function() {
    log.info("Killing all clients");
    return this._clientPool.killAllClients();
}

IrcBridge.prototype.isStartedUp = function() {
    return this._startedUp;
};

IrcBridge.prototype._joinMappedMatrixRooms = Promise.coroutine(function*() {
    let roomIds = yield this.getStore().getRoomIdsFromConfig();
    let promises = roomIds.map((roomId) => {
        if (this.joinedRoomList.includes(roomId)) {
            log.debug(`Not joining ${roomId} because we are marked as joined`);
            return Promise.resolve();
        }
        return this._bridge.getIntent().join(roomId);
    });
    yield promiseutil.allSettled(promises);
});

IrcBridge.prototype.sendMatrixAction = function(room, from, action, req) {
    let msgtype = ACTION_TYPE_TO_MSGTYPE[action.type];
    let intent = this._bridge.getIntent(from.userId);
    if (msgtype) {
        if (action.htmlText) {
            return intent.sendMessage(room.getId(), {
                msgtype: msgtype,
                body: (
                    action.text || action.htmlText.replace(/(<([^>]+)>)/ig, "") // strip html tags
                ),
                format: "org.matrix.custom.html",
                formatted_body: action.htmlText
            });
        }
        return intent.sendMessage(room.getId(), {
            msgtype: msgtype,
            body: action.text
        });
    }
    else if (action.type === "topic") {
        return intent.setRoomTopic(room.getId(), action.text);
    }
    return Promise.reject(new Error("Unknown action: " + action.type));
};

IrcBridge.prototype.uploadTextFile = function(fileName, plaintext, req) {
    return this._bridge.getIntent().getClient().uploadContent({
        stream: new Buffer(plaintext),
        name: fileName,
        type: "text/plain; charset=utf-8",
        rawResponse: true,
    });
};

IrcBridge.prototype.getMatrixUser = Promise.coroutine(function*(ircUser) {
    let matrixUser = null;
    let userLocalpart = ircUser.server.getUserLocalpart(ircUser.nick);
    let displayName = ircUser.server.getDisplayNameFromNick(ircUser.nick);

    try {
        matrixUser = yield this.getStore().getMatrixUserByLocalpart(userLocalpart);
        if (matrixUser) {
            return matrixUser;
        }
    }
    catch (e) {
        // user does not exist. Fall through.
    }

    let userIntent = this._bridge.getIntentFromLocalpart(userLocalpart);
    yield userIntent.setDisplayName(displayName); // will also register this user
    matrixUser = new MatrixUser(userIntent.getClient().credentials.userId);
    matrixUser.setDisplayName(displayName);
    yield this.getStore().storeMatrixUser(matrixUser);
    return matrixUser;
});

IrcBridge.prototype.onEvent = function(request, context) {
    request.outcomeFrom(this._onEvent(request, context));
};

IrcBridge.prototype._onEvent = Promise.coroutine(function*(baseRequest, context) {
    var event = baseRequest.getData();
    var request = new BridgeRequest(baseRequest, false);
    if (event.type === "m.room.message") {
        if (event.origin_server_ts && this.config.homeserver.dropMatrixMessagesAfterSecs) {
            let now = Date.now();
            if ((now - event.origin_server_ts) >
                    (1000 * this.config.homeserver.dropMatrixMessagesAfterSecs)) {
                log.info(
                    "Dropping old m.room.message event %s timestamped %d",
                    event.event_id, event.origin_server_ts
                );
                return BridgeRequest.ERR_DROPPED;
            }
        }
        yield this.matrixHandler.onMessage(request, event);
    }
    else if (event.type === "m.room.topic" && event.state_key === "") {
        yield this.matrixHandler.onMessage(request, event);
    }
    else if (event.type === "m.room.member") {
        if (!event.content || !event.content.membership) {
            return BridgeRequest.ERR_NOT_MAPPED;
        }
        this.ircHandler.onMatrixMemberEvent(event);
        var target = new MatrixUser(event.state_key);
        var sender = new MatrixUser(event.user_id);
        if (event.content.membership === "invite") {
            yield this.matrixHandler.onInvite(request, event, sender, target);
        }
        else if (event.content.membership === "join") {
            yield this.matrixHandler.onJoin(request, event, target);
        }
        else if (["ban", "leave"].indexOf(event.content.membership) !== -1) {
            // Given a "self-kick" is a leave, and you can't ban yourself,
            // if the 2 IDs are different then we know it is either a kick
            // or a ban (or a rescinded invite)
            var isKickOrBan = target.getId() !== sender.getId();
            if (isKickOrBan) {
                yield this.matrixHandler.onKick(request, event, sender, target);
            }
            else {
                yield this.matrixHandler.onLeave(request, event, target, sender);
            }
        }
    }
    return undefined;
});

IrcBridge.prototype.onUserQuery = Promise.coroutine(function*(matrixUser) {
    var baseRequest = this._bridge.getRequestFactory().newRequest();
    var request = new BridgeRequest(baseRequest, false);
    yield this.matrixHandler.onUserQuery(request, matrixUser.getId());
    // TODO: Lean on the bridge lib more
    return null; // don't provision, we already do atm
});

IrcBridge.prototype.onAliasQuery = Promise.coroutine(function*(alias, aliasLocalpart) {
    var baseRequest = this._bridge.getRequestFactory().newRequest();
    var request = new BridgeRequest(baseRequest, false);
    yield this.matrixHandler.onAliasQuery(request, alias);
    // TODO: Lean on the bridge lib more
    return null; // don't provision, we already do atm
});

IrcBridge.prototype.onLog = function(line, isError) {
    if (isError) {
        log.error(line);
    }
    else {
        log.info(line);
    }
};

IrcBridge.prototype.getThirdPartyProtocol = function(protocol) {
    var servers = this.getServers();

    return Promise.resolve({
        user_fields: ["domain", "nick"],
        location_fields: ["domain", "channel"],
        field_types: {
            domain: {
                regexp: "[a-z0-9-_]+(\.[a-z0-9-_]+)*",
                placeholder: "irc.example.com",
            },
            nick: {
                regexp: "[^#\\s]+",
                placeholder: "SomeNick",
            },
            channel: {
                // TODO(paul): Declare & and + in this list sometime when the
                //   bridge can support them
                regexp: "[#][^\\s]+",
                placeholder: "#channel",
            },
        },
        instances: servers.map((server) => {
            return {
                network_id: server.getNetworkId(),
                bot_user_id: this.getAppServiceUserId(),
                desc: server.config.name || server.domain,
                icon: server.config.icon,
                fields: {
                    domain: server.domain,
                },
            };
        }),
    });
};

IrcBridge.prototype.getThirdPartyLocation = function(protocol, fields) {
    if (!fields.domain) {
        return Promise.reject({err: "Expected 'domain' field", code: 400});
    }
    var domain = fields.domain.toLowerCase();

    if (!fields.channel) {
        return Promise.reject({err: "Expected 'channel' field", code: 400});
    }
    // TODO(paul): this ought to use IRC network-specific casefolding (e.g. rfc1459)
    var channel = fields.channel.toLowerCase();

    var server = this.getServer(domain);
    if (!server) {
        return Promise.resolve([]);
    }

    if (!server.config.dynamicChannels.enabled) {
        return Promise.resolve([]);
    }

    var alias = server.getAliasFromChannel(channel);

    return Promise.resolve([
        {
            alias: alias,
            protocol: "irc",
            fields: {
                domain: domain,
                channel: channel,
            }
        }
    ]);
};

IrcBridge.prototype.getThirdPartyUser = function(protocol, fields) {
    if (!fields.domain) {
        return Promise.reject({err: "Expected 'domain' field", code: 400});
    }
    var domain = fields.domain.toLowerCase();

    if (!fields.nick) {
        return Promise.reject({err: "Expected 'nick' field", code: 400});
    }
    // TODO(paul): this ought to use IRC network-specific casefolding (e.g. rfc1459)
    var nick = fields.nick.toLowerCase();

    var server = this.getServer(domain);
    if (!server) {
        return Promise.resolve([]);
    }

    var userId = server.getUserIdFromNick(nick);

    return Promise.resolve([
        {
            userid: userId,
            protocol: "irc",
            fields: {
                domain: domain,
                nick: nick,
            }
        }
    ]);
};

IrcBridge.prototype.getIrcUserFromCache = function(server, userId) {
    return this._clientPool.getBridgedClientByUserId(server, userId);
};

IrcBridge.prototype.getBridgedClientsForUserId = function(userId) {
    return this._clientPool.getBridgedClientsForUserId(userId);
};

IrcBridge.prototype.getServer = function(domainName) {
    for (var i = 0; i < this.ircServers.length; i++) {
        var server = this.ircServers[i];
        if (server.domain === domainName) {
            return server;
        }
    }
    return null;
};

IrcBridge.prototype.getServers = function() {
    return this.ircServers || [];
};

// TODO: Check how many of the below functions need to reside on IrcBridge still.

IrcBridge.prototype.aliasToIrcChannel = function(alias) {
    var ircServer = null;
    var servers = this.getServers();
    for (var i = 0; i < servers.length; i++) {
        var server = servers[i];
        if (server.claimsAlias(alias)) {
            ircServer = server;
            break;
        }
    }
    if (!ircServer) {
        return {};
    }
    return {
        server: ircServer,
        channel: ircServer.getChannelFromAlias(alias)
    };
};

IrcBridge.prototype.getServerForUserId = function(userId) {
    let servers = this.getServers();
    for (let i = 0; i < servers.length; i++) {
        if (servers[i].claimsUserId(userId)) {
            return servers[i];
        }
    }
    return null;
}

IrcBridge.prototype.matrixToIrcUser = function(user) {
    var server = this.getServerForUserId(user.getId());
    var ircInfo = {
        server: server,
        nick: server ? server.getNickFromUserId(user.getId()) : null
    };
    if (!ircInfo.server || !ircInfo.nick) {
        return Promise.reject(
            new Error("User ID " + user.getId() + " doesn't map to a server/nick")
        );
    }
    return Promise.resolve(new IrcUser(ircInfo.server, ircInfo.nick, true));
};

IrcBridge.prototype.trackChannel = function(server, channel, key) {
    if (!server.isBotEnabled()) {
        log.info("trackChannel: Bot is disabled.");
        return Promise.resolve(new IrcRoom(server, channel));
    }
    return this.getBotClient(server).then(function(client) {
        return client.joinChannel(channel, key);
    }).catch(log.logErr);
};

IrcBridge.prototype.connectToIrcNetworks = function() {
    return promiseutil.allSettled(this.ircServers.map((server) => {
        return this._loginToServer(server);
    }));
};

IrcBridge.prototype._loginToServer = Promise.coroutine(function*(server) {
    var uname = "matrixirc";
    var bridgedClient = this.getIrcUserFromCache(server, uname);
    if (!bridgedClient) {
        var botIrcConfig = server.createBotIrcClientConfig(uname);
        bridgedClient = this._clientPool.createIrcClient(botIrcConfig, null, true);
        log.debug(
            "Created new bot client for %s : %s (bot enabled=%s)",
            server.domain, bridgedClient._id, server.isBotEnabled()
        );
    }
    var chansToJoin = [];
    if (server.isBotEnabled()) {
        if (server.shouldJoinChannelsIfNoUsers()) {
            chansToJoin = yield this.getStore().getTrackedChannelsForServer(server.domain);
        }
        else {
            chansToJoin = yield this.memberListSyncers[server.domain].getChannelsToJoin();
        }
    }
    log.info("Bot connecting to %s (%s channels) => %s",
        server.domain, chansToJoin.length, JSON.stringify(chansToJoin)
    );
    try {
        yield bridgedClient.connect();
    }
    catch (err) {
        log.error("Bot failed to connect to %s : %s - Retrying....",
            server.domain, JSON.stringify(err));
        log.logErr(err);
        return this._loginToServer(server);
    }
    this._clientPool.setBot(server, bridgedClient);
    var num = 1;
    chansToJoin.forEach((c) => {
        // join a channel every 500ms. We stagger them like this to
        // avoid thundering herds
        setTimeout(function() {
            // catch this as if this rejects it will hard-crash
            // since this is a new stack frame which will bubble
            // up as an uncaught exception.
            bridgedClient.joinChannel(c).catch((e) => {
                log.error("Failed to join channel:: %s", c);
                log.error(e);
            });
        }, 500 * num);
        num += 1;
    });
    return undefined;
});

IrcBridge.prototype.checkNickExists = function(server, nick) {
    log.info("Querying for nick %s on %s", nick, server.domain);
    return this.getBotClient(server).then(function(client) {
        return client.whois(nick);
    });
};

IrcBridge.prototype.joinBot = function(ircRoom) {
    if (!ircRoom.server.isBotEnabled()) {
        log.info("joinBot: Bot is disabled.");
        return Promise.resolve();
    }
    return this.getBotClient(ircRoom.server).then((client) => {
        return client.joinChannel(ircRoom.channel);
    }).catch((e) => {
        log.error("Bot failed to join channel %s", ircRoom.channel);
    });
};

IrcBridge.prototype.partBot = function(ircRoom) {
    log.info(
        "Parting bot from %s on %s", ircRoom.channel, ircRoom.server.domain
    );
    return this.getBotClient(ircRoom.server).then((client) => {
        return client.leaveChannel(ircRoom.channel);
    });
};

IrcBridge.prototype.getBridgedClient = Promise.coroutine(function*(server, userId,
                                                         displayName) {
    let bridgedClient = this.getIrcUserFromCache(server, userId);
    if (bridgedClient) {
        log.debug("Returning cached bridged client %s", userId);
        return bridgedClient;
    }

    let mxUser = new MatrixUser(userId);
    mxUser.setDisplayName(displayName);

    // check the database for stored config information for this irc client
    // including username, custom nick, nickserv password, etc.
    let ircClientConfig = IrcClientConfig.newConfig(
        mxUser, server.domain, null
    );
    let storedConfig = yield this.getStore().getIrcClientConfig(userId, server.domain);
    if (storedConfig) {
        log.debug("Configuring IRC user from store => " + storedConfig);
        ircClientConfig = storedConfig;
    }

    // recheck the cache: We just yield'ed to check the client config. We may
    // be racing with another request to getBridgedClient.
    bridgedClient = this.getIrcUserFromCache(server, userId);
    if (bridgedClient) {
        log.debug("Returning cached bridged client %s", userId);
        return bridgedClient;
    }

    log.debug(
        "Creating virtual irc user with nick %s for %s (display name %s)",
        ircClientConfig.getDesiredNick(), userId, displayName
    );
    bridgedClient = this._clientPool.createIrcClient(ircClientConfig, mxUser, false);

    try {
        yield bridgedClient.connect();
        if (!storedConfig) {
            yield this.getStore().storeIrcClientConfig(ircClientConfig);
        }
        return bridgedClient;
    }
    catch (err) {
        log.error("Couldn't connect virtual user %s to %s : %s",
                ircClientConfig.getDesiredNick(), server.domain, JSON.stringify(err));
        throw err;
    }
});

IrcBridge.prototype.sendIrcAction = function(ircRoom, bridgedClient, action) {
    log.info(
        "Sending IRC message in %s as %s (connected=%s)",
        ircRoom.channel, bridgedClient.nick, Boolean(bridgedClient.unsafeClient)
    );
    return bridgedClient.sendAction(ircRoom, action);
};

IrcBridge.prototype.getBotClient = function(server) {
    var botClient = this._clientPool.getBot(server);
    if (botClient) {
        return Promise.resolve(botClient);
    }
    return this._loginToServer(server).then(() => {
        return this._clientPool.getBot(server);
    });
}

IrcBridge.prototype._fetchJoinedRooms = Promise.coroutine(function*() {
    /** Fetching joined rooms is quicker on larger homeservers than trying to
     * /join each room in the mappings list. To ensure we start quicker,
     * the bridge will block on this call rather than blocking on all join calls.
     * On the most overloaded servers even this call may take several attempts,
     * so it will block indefinitely.
     */
    const bot = this._bridge.getBot();
    if (bot.getJoinedRooms == undefined) {
        return;
    }
    let gotRooms = false;
    while (!gotRooms) {
        try {
            const roomIds = yield bot.getJoinedRooms();
            gotRooms = true;
            this.joinedRoomList = roomIds;
            log.info(`ASBot is in ${roomIds.length} rooms!`);
        }
        catch (ex) {
            log.error(`Failed to fetch roomlist from joined_rooms: ${ex}. Retrying`);
            yield Promise.delay(DELAY_FETCH_ROOM_LIST_MS);
        }
    }
});

IrcBridge.prototype._onRoomUpgrade = Promise.coroutine(function*(oldRoomId, newRoomId) {
    log.info(`Room has been upgraded from ${oldRoomId} to ${newRoomId}, updating ghosts..`);
    // Get the channels for the room_id
    const rooms = yield this.getStore().getIrcChannelsForRoomId(newRoomId);
    // Get users who we wish to leave.
    const asBot = this._bridge.getBot();
    const stateEvents = yield asBot.getClient().roomState(oldRoomId);
    const roomInfo = asBot._getRoomInfo(oldRoomId, {
        state: {
            events: stateEvents
        }
    });
    const bridgingEvent = stateEvents.find((ev) => ev.type === "m.room.bridging");
    if (bridgingEvent) {
        // The room had a bridge state event, so try to stick it in the new one.
        try {
            yield this._bridge.getIntent().sendStateEvent(
                newRoomId,
                "m.room.bridging",
                bridgingEvent.state_key,
                bridgingEvent.content
            );
            log.info("m.room.bridging event copied to new room");
        }
        catch (ex) {
            // We may not have permissions to do so, which means we are basically stuffed.
            log.warn("Could not send m.room.bridging event to new room:", ex);
        }
    }
    yield Promise.all(rooms.map((room) => {
        return this.getBotClient(room.getServer()).then((bot) => {
            // This will invoke NAMES and make members join the new room,
            // so we don't need to await it.
            bot.getNicks(room.getChannel()).catch(() => {
                log.error("Failed to get nicks for upgraded room");
            });
            log.info(
                `Leaving ${roomInfo.remoteJoinedUsers.length} users from old room ${oldRoomId}.`
            );
            this.memberListSyncers[room.getServer().domain].addToLeavePool(
                roomInfo.remoteJoinedUsers,
                oldRoomId,
                room
            );
        })
    }));
    log.info(`Ghost migration to ${newRoomId} complete`);
});

IrcBridge.DEFAULT_LOCALPART = "appservice-irc";

module.exports = IrcBridge;
