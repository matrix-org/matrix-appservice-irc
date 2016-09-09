/*eslint no-invalid-this: 0*/ // eslint doesn't understand Promise.coroutine wrapping
"use strict";
var Promise = require("bluebird");
var IrcRoom = require("../models/IrcRoom");
var IrcAction = require("../models/IrcAction");
var MatrixRoom = require("matrix-appservice-bridge").MatrixRoom;
var ConfigValidator = require("matrix-appservice-bridge").ConfigValidator;

var log = require("../logging").get("Provisioner");
var promiseutil = require("../promiseutil.js");

var matrixRoomIdValidation = {
    "type": "string",
    "pattern": "^!.*:.*$"
};

var validationProperties = {
    "matrix_room_id" : matrixRoomIdValidation,
    "remote_room_channel" : {
        "type": "string",
        "pattern": "^([#+&]|(![A-Z0-9]{5}))[^\\s:,]+$"
    },
    "remote_room_server" : {
        "type": "string",
        "pattern": "^[a-z\\.0-9:-]+$"
    },
    "op_nick" : {
        "type": "string"
    },
    "key" : {
        "type": "string"
    },
    "user_id" : {
        "type": "string"
    }
};

function Provisioner(ircBridge, enabled, requestTimeoutSeconds) {
    this._ircBridge = ircBridge;
    this._enabled = enabled;
    this._requestTimeoutSeconds = requestTimeoutSeconds;
    this._pendingRequests = {};
    // {
    //   $domain: {
    //     $nick: {
    //        userId : string
    //        defer: Deferred
    //     }
    //   }

    this._linkValidator = new ConfigValidator({
        "type": "object",
        "properties": validationProperties,
        "required": [
            "matrix_room_id",
            "remote_room_channel",
            "remote_room_server",
            "op_nick",
            "user_id"
        ]
    });
    this._unlinkValidator = new ConfigValidator({
        "type": "object",
        "properties": validationProperties,
        "required": [
            "matrix_room_id",
            "remote_room_channel",
            "remote_room_server"
        ]
    });
    this._roomIdValidator = new ConfigValidator({
        "type": "object",
        "properties": {
            "matrix_room_id" : matrixRoomIdValidation
        }
    });

    if (enabled) {
        log.info("Starting provisioning...");
    }
    else {
        log.info("Provisioning disabled.");
    }

    let as = this._ircBridge.getAppServiceBridge().appService;
    let self = this;

    if (enabled && !(as.app.use && as.app.get && as.app.post)) {
        throw new Error('Could not start provisioning API');
    }

    // Disable all provision endpoints by not calling 'next' and returning an error instead
    if (!enabled) {
        as.app.use(function(req, res, next) {
            if (self.isProvisionRequest(req)) {
                res.header("Access-Control-Allow-Origin", "*");
                res.header("Access-Control-Allow-Headers",
                    "Origin, X-Requested-With, Content-Type, Accept");
                res.status(200);
                res.json({error : 'Provisioning is not enabled.'});
            }
            else {
                next();
            }
        });
    }

    // Deal with CORS (temporarily for s-web)
    as.app.use(function(req, res, next) {
        if (self.isProvisionRequest(req)) {
                res.header("Access-Control-Allow-Origin", "*");
                res.header("Access-Control-Allow-Headers",
                    "Origin, X-Requested-With, Content-Type, Accept");
        }
        next();
    });

    as.app.post("/_matrix/provision/link", Promise.coroutine(function*(req, res) {
        try {
            yield self.requestLink(req.body);
            res.json({});
        }
        catch (err) {
            res.status(500).json({error: err.message});
            throw err;
        }
    }));

    as.app.post("/_matrix/provision/unlink", Promise.coroutine(function*(req, res) {
        try {
            yield self.unlink(req.body);
            res.json({});
        }
        catch (err) {
            res.status(500).json({error: err.message});
            throw err;
        }
    }));

    as.app.get("/_matrix/provision/listlinks/:roomId", Promise.coroutine(function*(req, res) {
        try {
            let list = yield self.listings(req.params.roomId);
            res.json(list);
        }
        catch (err) {
            res.status(500).json({error: err.message});
            throw err;
        }
    }));

    if (enabled) {
        log.info("Provisioning started");
    }
}

Provisioner.prototype.isProvisionRequest = function(req) {
    return req.url === '/_matrix/provision/unlink' ||
            req.url === '/_matrix/provision/link'||
            req.url.match(/^\/_matrix\/provision\/listlinks/)
};

Provisioner.prototype._updateBridgingState = Promise.coroutine(
    function*(roomId, userId, status, skey) {
        let intent = this._ircBridge.getAppServiceBridge().getIntent();
        try {
            yield intent.client.sendStateEvent(roomId, 'm.room.bridging', {
                user_id: userId,
                status: status // pending, success, failure
            }, skey);
        }
        catch (err) {
            console.error(err);
            throw new Error(`Could not update m.room.bridging state in this room`);
        }
    }
);

// Do a series of checks before contacting an operator for permission to create
//  a provisioned mapping. If the operator responds with 'yes' or 'y', the mapping
//  is created.
// The checks done are the following:
//  - (Matrix) Check power level of user is high enough
//  - (IRC) Check that op's nick is actually a channel op
//  - (Matrix) check room state to prevent route looping: don't bridge the same
//    room-channel pair
//  - (Matrix) update room state m.room.brdiging
Provisioner.prototype._authoriseProvisioning = Promise.coroutine(
    function*(server, userId, ircChannel, roomId, opNick, key) {
        let ircDomain = server.domain;

        let existing = this._getRequest(server, opNick);
        if (existing) {
            let from = existing.userId;
            throw new Error(`Bridging request already sent to `+
                            `${opNick} on ${server.domain} from ${from}`);
        }

        // (Matrix) Check power level of user
        log.info(`Check power level of ${userId} in ${roomId}`);
        let matrixClient = this._ircBridge.getAppServiceBridge().getClientFactory().getClientAs();

        let powerState = null;
        try {
            powerState = yield matrixClient.getStateEvent(roomId, 'm.room.power_levels');
        }
        catch (err) {
            log.error(`Error retrieving power levels (${err.data.error})`);
        }

        if (!powerState) {
            throw new Error('Could not retrieve your power levels for the room');
        }

        let actualPower = 0;
        if (powerState.users[userId] !== undefined) {
            actualPower = powerState.users[userId];
        }
        else if (powerState.users_default !== undefined) {
            actualPower = powerState.users_default;
        }

        let requiredPower = 50;
        if (powerState.events["m.room.power_levels"] !== undefined) {
            requiredPower = powerState.events["m.room.power_levels"]
        }
        else if (powerState.state_default !== undefined) {
            requiredPower = powerState.state_default;
        }

        if (actualPower < requiredPower) {
            throw new Error('User does not possess high enough power level');
        }

        // (IRC) Check that op's nick is actually op
        log.info(`Check that op's nick is actually op`);
        let botClient = yield this._ircBridge.getBotClient(server);
        yield botClient.joinChannel(ircChannel, key);
        log.info(`Bot joined channel ${ircChannel}`);
        let info = yield botClient.getOperators(ircChannel);

        if (info.nicks.indexOf(opNick) === -1) {
            let knownOps = info.operatorNicks.join(', ');
            throw new Error(`Provided user is not in channel ${ircChannel}. ` +
                            `Known ops in this channel: ${knownOps}`);
        }

        if (info.operatorNicks.indexOf(opNick) === -1) {
            let knownOps = info.operatorNicks.join(', ');
            throw new Error(`Provided user is not an op of ${ircChannel}. ` +
                            `Known ops in this channel: ${knownOps}`);
        }

        // State key for m.room.bridging
        let skey = `irc://${ircDomain}/${ircChannel}`;

        // (Matrix) check room state to prevent route looping
        try {
            let wholeBridgingState = yield matrixClient.getWholeStateEvent(
                roomId, 'm.room.bridging', skey
            );
            let bridgingState = wholeBridgingState.content;
            // Bridging state exists and is either success or pending (ignore failures)
            if (bridgingState && bridgingState.status !== 'failure') {
                // If bridging state sender is the provisioner
                if (bridgingState.user_id === userId) {
                    // Success, already pending/success
                    log.info(`Bridging state already exists in room ${roomId} ` +
                             `(status = ${bridgingState.status},` +
                             ` bridger = ${bridgingState.user_id}. Ignoring request.`);
                    return;
                }// If it is from a different sender, fail
                throw new Error(`A request to create this mapping has already been sent ` +
                         `(status = ${bridgingState.status},` +
                         ` bridger = ${bridgingState.user_id}. Ignoring request.`);
            }
        }
        catch (err) {
            // The request to discover bridging state has failed

            // http-api error indicated by errcode
            if (err.errcode) {
                //  ignore M_NOT_FOUND: this bridging does not exist
                console.error(err);
                if (err.errcode !== 'M_NOT_FOUND') {
                    throw new Error(err.data.error);
                }
            }
            else {
                throw err;
            }
        }

        log.info(`Sending m.room.bridging to ${roomId}, state key = ${skey}`);

        // (Matrix) update room state
        // Send pending m.room.bridging
        yield this._updateBridgingState(roomId, userId, 'pending', skey);

        // (IRC) Ask operator for authorisation
        // Time that operator has to respond before giving up
        let timeoutSeconds = this._requestTimeoutSeconds;

        // Deliberately not yielding on this so that 200 OK is returned
        log.info(`Contacting operator`);
        this._createAuthorisedLink(
            botClient, server, opNick, ircChannel,
            roomId, userId, skey, timeoutSeconds);
    }
);

// Contact an operator, asking for authorisation for a mapping, and if they reply
//  'yes' or 'y', create the mapping.
Provisioner.prototype._createAuthorisedLink = Promise.coroutine(
    function*(botClient, server, opNick, ircChannel, roomId, userId, skey, timeoutSeconds) {
        let d = promiseutil.defer();

        // Send PM to operator
        let authRequestAction = new IrcAction("message",
            `${userId} has requested to bridge ${roomId} with ${ircChannel} on this IRC ` +
            `network. Respond with 'yes' or 'y' to allow, or simply ignore this message to ` +
            `disallow. You have ${timeoutSeconds} seconds from when this message was sent.`);
        let pmRoom = new IrcRoom(server, opNick);

        this._setRequest(server, opNick, {userId: userId, defer: d});

        this._ircBridge.sendIrcAction(pmRoom, botClient, authRequestAction);
        try {
            yield d.promise.timeout(timeoutSeconds * 1000);
            this._removeRequest(server, opNick);
        }
        catch (err) {
            log.info(`Operator ${opNick} did not respond (${err.message})`);
            yield this._updateBridgingState(roomId, userId, 'failure', skey);
            this._removeRequest(server, opNick);
            return;
        }
        try {
            yield this._doLink(server, ircChannel, roomId);
        }
        catch (err) {
            log.info(`Failed to create link following authorisation (${err.message})`);
            yield this._updateBridgingState(roomId, userId, 'failure', skey);
            this._removeRequest(server, opNick);
            return;
        }
        yield this._updateBridgingState(roomId, userId, 'success', skey);
    }
);

Provisioner.prototype._removeRequest = function (server, opNick) {
    if (this._pendingRequests[server.domain]) {
        delete this._pendingRequests[server.domain][opNick];
    }
}

Provisioner.prototype._getRequest = function (server, opNick) {
    if (this._pendingRequests[server.domain]) {
        return this._pendingRequests[server.domain][opNick];
    }
}

Provisioner.prototype._setRequest = function (server, opNick, request) {
    if (!this._pendingRequests[server.domain]) {
        this._pendingRequests[server.domain] = {};
    }
    this._pendingRequests[server.domain][opNick] = request;
}

Provisioner.prototype.handlePm = function(server, fromUser, text) {
    if (['y', 'yes'].indexOf(text.trim().toLowerCase()) == -1) {
        log.warn(`Provisioner only handles text 'yes'/'y' ` +
                 `(from ${fromUser.nick} on ${server.domain})`);
        return;
    }
    let request = this._getRequest(server, fromUser.nick);
    if (request) {
        log.info(`${fromUser.nick} has authorised a new provisioning`);
        request.defer.resolve();
        return;
    }
    log.warn(`Provisioner was not expecting PM from ${fromUser.nick} on ${server.domain}`);
}

// Link an IRC channel to a matrix room ID
Provisioner.prototype.requestLink = Promise.coroutine(function*(options) {
    try {
        this._linkValidator.validate(options);
    }
    catch (err) {
        log.error(err);
        throw new Error("Malformed parameters");
    }

    let ircDomain = options.remote_room_server;
    let ircChannel = options.remote_room_channel;
    let roomId = options.matrix_room_id;
    let opNick = options.op_nick;
    let key = options.key || undefined; // Optional key
    let userId = options.user_id;
    let mappingLogId = `${roomId} <---> ${ircDomain}/${ircChannel}`;

    // Try to find the domain requested for linking
    //TODO: ircDomain might include protocol, i.e. irc://irc.freenode.net
    let server = this._ircBridge.getServer(ircDomain);

    if (!server) {
        throw new Error(`Server requested for linking not found ('${ircDomain}')`);
    }

    if (server.isExcludedChannel(ircChannel)) {
        throw new Error(`Server is configured to exclude given channel ('${ircChannel}')`);
    }

    let entry = yield this._ircBridge.getStore().getRoom(roomId, ircDomain, ircChannel);
    if (!entry) {
        // Ask OP for provisioning authentication
        try {
            yield this._authoriseProvisioning(server, userId, ircChannel, roomId, opNick, key);
        }
        catch (err) {
            console.error(err.stack);
            throw new Error('Failed to authorise provisioning');
        }
    }
    else {
        throw new Error(`Room mapping already exists (${mappingLogId},` +
                        `origin = ${entry.data.origin})`);
    }
});

Provisioner.prototype._doLink = Promise.coroutine(
    function*(server, ircChannel, roomId) {
        let ircDomain = server.domain;
        let mappingLogId = `${roomId} <---> ${ircDomain}/${ircChannel}`;
        log.info(`Provisioning link for room ${mappingLogId}`);

        // Create rooms for the link
        let ircRoom = new IrcRoom(server, ircChannel);
        let mxRoom = new MatrixRoom(roomId);

        let entry = yield this._ircBridge.getStore().getRoom(roomId, ircDomain, ircChannel);
        if (!entry) {
            yield this._ircBridge.getStore().storeRoom(ircRoom, mxRoom, 'provision');
        }
        else {
            throw new Error(`Room mapping already exists (${mappingLogId},` +
                            `origin = ${entry.data.origin})`);
        }
    }
);

// Unlink an IRC channel from a matrix room ID
Provisioner.prototype.unlink = Promise.coroutine(function*(options) {
    try {
        this._unlinkValidator.validate(options);
    }
    catch (err) {
        log.error(err);
        throw new Error("Malformed parameters");
    }

    let ircDomain = options.remote_room_server;
    let ircChannel = options.remote_room_channel;
    let roomId = options.matrix_room_id;
    let mappingLogId = `${roomId} <-/-> ${ircDomain}/${ircChannel}`;

    log.info(`Provisioning unlink for room ${mappingLogId}`);

    // Try to find the domain requested for unlinking
    let server = this._ircBridge.getServer(ircDomain);

    if (!server) {
        throw new Error("Server requested for linking not found");
    }

    // Delete the room link
    let entry = yield this._ircBridge.getStore()
        .getRoom(roomId, ircDomain, ircChannel, 'provision');

    if (entry) {
        yield this._ircBridge.getStore().removeRoom(roomId, ircDomain, ircChannel, 'provision');
    }
    else {
        throw new Error(`Provisioned room mapping does not exist (${mappingLogId})`);
    }
});

// List all mappings currently provisioned with the given matrix_room_id
Provisioner.prototype.listings = function(roomId) {
    try {
        this._roomIdValidator.validate({"matrix_room_id": roomId});
    }
    catch (err) {
        log.error(err);
        throw new Error("Malformed parameters");
    }

    return this._ircBridge.getStore()
        .getProvisionedMappings(roomId)
        .map((entry) => {
            return {
                matrix_room_id : entry.matrix.roomId,
                remote_room_channel : entry.remote.data.channel,
                remote_room_server : entry.remote.data.domain,
            }
        });
};

module.exports = Provisioner;
