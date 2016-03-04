/*eslint no-invalid-this: 0*/ // eslint doesn't understand Promise.coroutine wrapping
"use strict";
var Promise = require("bluebird");
var extend = require("extend");

var promiseutil = require("../promiseutil");
var store = require("../store");
var IrcHandler = require("./irc-handler.js");
var MatrixHandler = require("./matrix-handler.js");
var MemberListSyncer = require("./member-list-syncer.js");
var ircLib = require("../irclib/irc.js");
var names = require("../irclib/names.js");
var IrcServer = require("../irclib/server.js").IrcServer;
var matrixLib = require("../mxlib/matrix");
var MatrixUser = require("../models/users").MatrixUser;
var BridgeRequest = require("../models/bridge-request");
var stats = require("../config/stats");
var logging = require("../logging");
var log = logging.get("IrcBridge");
var Bridge = require("matrix-appservice-bridge").Bridge;

const DELAY_TIME_MS = 10 * 1000;
const DEAD_TIME_MS = 5 * 60 * 1000;


function IrcBridge(config, registration) {
    this.config = config;
    this.registration = registration;
    this.ircServers = [];
    this.bridge = null; // Bridge
    this.domain = null; // String
    this.appServiceUserId = null; // String
    this.memberListSyncers = {
    //  domain: MemberListSyncer
    };
    this.matrixHandler = new MatrixHandler(this);
    this.ircHandler = new IrcHandler(this);
}

IrcBridge.prototype.getAppServiceUserId = function() {
    return this.appServiceUserId;
};

IrcBridge.prototype.run = Promise.coroutine(function*(port) {
    // connect to the DB, blow away any old config mappings, we're setting new ones now.
    yield store.connectToDatabase(this.config.ircService.databaseUri);
    yield store.rooms.removeConfigMappings();

    // maintain a list of IRC servers in-use
    let serverDomains = Object.keys(this.config.ircService.servers);
    for (var i = 0; i < serverDomains.length; i++) {
        let domain = serverDomains[i];
        let server = new IrcServer(
            domain,
            extend(true, IrcServer.DEFAULT_CONFIG, this.config.ircService.servers[domain])
        );
        // store the config mappings in the DB to keep everything in one place.
        yield store.setServerFromConfig(server, this.config.ircService.servers[domain]);
        this.ircServers.push(server);
    }

    if (this.ircServers.length === 0) {
        throw new Error("No IRC servers specified.");
    }

    // glue IRC side
    ircLib.registerHooks({ // FIXME: inject ircLib.
        onMessage: this.ircHandler.onMessage.bind(this.ircHandler),
        onPrivateMessage: this.ircHandler.onPrivateMessage.bind(this.ircHandler),
        onJoin: this.ircHandler.onJoin.bind(this.ircHandler),
        onPart: this.ircHandler.onPart.bind(this.ircHandler),
        onMode: this.ircHandler.onMode.bind(this.ircHandler)
    });
    ircLib.setServers(this.ircServers);
    names.initQueue();

    // glue Matrix side
    this.bridge = new Bridge({
        registration: this.registration,
        homeserverUrl: this.config.homeserver.url,
        domain: this.config.homeserver.domain,
        controller: this,
        roomStore: "_unused_rooms.db", // we use our own for now
        userStore: "_unused_users.db", // we use our own for now
        suppressEcho: false, // we use our own dupe suppress for now
        queue: {
            type: "none",
            perRequest: false
        }
    });
    // run the bridge (needs to be done prior to configure IRC side)
    yield this.bridge.run(port);
    this.bridge.getRequestFactory().addDefaultTimeoutCallback((req) => {
        this.onLog("[" + req.getId() + "] DELAYED (" + req.getDuration() + "ms)");
        stats.request(req.isFromIrc, "delay", req.getDuration());
    }, DELAY_TIME_MS);
    this.bridge.getRequestFactory().addDefaultTimeoutCallback((req) => {
        this.onLog("[" + req.getId() + "] DEAD (" + req.getDuration() + "ms)");
        stats.request(req.isFromIrc, "fail", req.getDuration());
    }, DEAD_TIME_MS);
    this.bridge.getRequestFactory().addDefaultResolveCallback((req) => {
        stats.request(req.isFromIrc, "success", req.getDuration());
    });
    this.bridge.getRequestFactory().addDefaultRejectCallback((req) => {
        stats.request(req.isFromIrc, "fail", req.getDuration());
    });

    ircLib.setIrcBridge(this);

    if (this.config.appService) {
        console.warn(
            `[DEPRECATED] Use of config field 'appService' is deprecated. Remove this
            field from the config file to remove this warning.

            This release will use values from this config field. This will produce
            a fatal error in a later release.`
        );
        this.domain = this.config.appService.homeserver.domain;
        this.appServiceUserId = (
            "@" + (this.config.appService.localpart || IrcBridge.DEFAULT_LOCALPART) + ":" +
            this.domain
        );

        matrixLib.setMatrixClientConfig({
            domain: this.domain
        }, this.bridge);
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

        matrixLib.setMatrixClientConfig({
            domain: this.domain
        }, this.bridge);
    }


    // start things going
    log.info("Joining mapped Matrix rooms...");
    yield this._joinMappedMatrixRooms();
    log.info("Syncing relevant membership lists...");
    this.ircServers.forEach((server) => {
        this.memberListSyncers[server.domain] = new MemberListSyncer(
            this.bridge.getBot(), server, this.appServiceUserId,
            (roomId, joiningUserId) => {
                var req = new BridgeRequest(
                    this.bridge.getRequestFactory().newRequest(), false
                );
                var target = new MatrixUser(joiningUserId, null, null);
                // inject a fake join event which will do M->I connections and
                // therefore sync the member list
                return this.matrixHandler.onJoin(req, {
                    event_id: "$fake:membershiplist",
                    room_id: roomId,
                    state_key: joiningUserId,
                    user_id: joiningUserId,
                    content: {
                        membership: "join"
                    },
                    _injected: true
                }, target);
            }
        );
        this.memberListSyncers[server.domain].sync();
    });
    log.info("Connecting to IRC networks...");
    yield ircLib.connect();
});

IrcBridge.prototype._joinMappedMatrixRooms = Promise.coroutine(function*() {
    let roomIds = yield store.rooms.getRoomIdsFromConfig();
    let lib = matrixLib.getMatrixLibFor();
    let promises = roomIds.map(function(roomId) {
        return lib.joinRoom(roomId);
    });
    yield promiseutil.allSettled(promises);
});

IrcBridge.prototype.getMatrixUser = Promise.coroutine(function*(ircUser) {
    let matrixUser = null;
    let userLocalpart = ircUser.server.getUserLocalpart(ircUser.nick);
    let displayName = ircUser.nick + " (IRC)";

    try {
        matrixUser = yield store.users.get(userLocalpart);
        if (matrixUser) {
            return matrixUser;
        }
    }
    catch (e) {
        // user does not exist. Fall through.
    }

    let userIntent = this.bridge.getIntentFromLocalpart(userLocalpart);
    yield userIntent.setDisplayName(displayName); // will also register this user
    matrixUser = new MatrixUser(
        userIntent.getClient().credentials.userId,
        displayName,
        true
    );
    yield store.users.set(matrixUser, userLocalpart, displayName, true);
    return matrixUser;
});

IrcBridge.prototype.onEvent = function(request, context) {
    request.outcomeFrom(this._onEvent(request, context));
};

IrcBridge.prototype._onEvent = Promise.coroutine(function*(baseRequest, context) {
    var event = baseRequest.getData();
    var request = new BridgeRequest(baseRequest, false);
    if (event.type === "m.room.message" || event.type === "m.room.topic") {
        yield this.matrixHandler.onMessage(request, event)
    }
    else if (event.type === "m.room.member") {
        if (!event.content || !event.content.membership) {
            return;
        }
        // MatrixUser(userId, displayName, isVirtual)
        var target = new MatrixUser(event.state_key, null, null);
        var sender = new MatrixUser(event.user_id, null, null);
        if (event.content.membership === "invite") {
            yield this.matrixHandler.onInvite(request, event, sender, target);
        }
        else if (event.content.membership === "join") {
            yield this.matrixHandler.onJoin(request, event, target);
        }
        else if (["ban", "leave"].indexOf(event.content.membership) !== -1) {
            yield this.matrixHandler.onLeave(request, event, target);
        }
    }
});

IrcBridge.prototype.onUserQuery = Promise.coroutine(function*(matrixUser) {
    var baseRequest = this.bridge.getRequestFactory().newRequest();
    var request = new BridgeRequest(baseRequest, false);
    yield this.matrixHandler.onUserQuery(request, matrixUser.userId);
    return null; // don't provision, we already do atm
});

IrcBridge.prototype.onAliasQuery = Promise.coroutine(function*(alias, aliasLocalpart) {
    var baseRequest = this.bridge.getRequestFactory().newRequest();
    var request = new BridgeRequest(baseRequest, false);
    yield this.matrixHandler.onAliasQuery(request, alias);
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

IrcBridge.DEFAULT_LOCALPART = "appservice-irc";

module.exports = IrcBridge;
