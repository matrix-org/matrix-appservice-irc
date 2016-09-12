/*eslint no-invalid-this: 0*/ // eslint doesn't understand Promise.coroutine wrapping
"use strict";
var Promise = require("bluebird");
var IrcRoom = require("../models/IrcRoom");
var IrcAction = require("../models/IrcAction");
var MatrixRoom = require("matrix-appservice-bridge").MatrixRoom;
var ConfigValidator = require("matrix-appservice-bridge").ConfigValidator;
var MatrixUser = require("matrix-appservice-bridge").MatrixUser;
var BridgeRequest = require("../models/BridgeRequest");

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
    // Cache bot clients so as not to create duplicates
    this._botClients = {};
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
    this._queryLinkValidator = new ConfigValidator({
        "type": "object",
        "properties": validationProperties,
        "required": [
            "remote_room_channel",
            "remote_room_server"
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

    as.app.post("/_matrix/provision/querylink", Promise.coroutine(function*(req, res) {
        try {
            let result = yield self.queryLink(req.body);
            res.json(result);
        }
        catch (err) {
            res.status(500).json({error: err.message});
            throw err;
        }
    }));

    as.app.get("/_matrix/provision/querynetworks", Promise.coroutine(function*(req, res) {
        try {
            let result = yield self.queryNetworks(req.body);
            res.json(result);
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
            req.url.match(/^\/_matrix\/provision\/listlinks/) ||
            req.url === '/_matrix/provision/querynetworks' ||
            req.url === "/_matrix/provision/querylink"
};

// Returns a bridgedClient representing a bot for the given server
Provisioner.prototype._getBotClientForServer = Promise.coroutine(
    function*(server) {
        if (!this._botClients[server.domain]) {
            this._botClients[server.domain] = yield this._ircBridge.getBotClient(server);
        }
        return this._botClients[server.domain];
});

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

Provisioner.prototype._userHasProvisioningPower = Promise.coroutine(
    function*(userId, roomId) {
        log.info(`Check power level of ${userId} in room ${roomId}`);
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

        return actualPower >= requiredPower;
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
        let hasPower = yield this._userHasProvisioningPower(userId, roomId);
        if (!hasPower) {
            throw new Error('User does not possess high enough power level');
        }

        // (IRC) Check that op's nick is actually op
        log.info(`Check that op's nick is actually op`);

        let botClient = yield this._getBotClientForServer(server);

        let info = yield botClient.getOperators(ircChannel, key);

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

        let matrixClient = this._ircBridge.getAppServiceBridge().getClientFactory().getClientAs();
        let wholeBridgingState = null;

        // (Matrix) check room state to prevent route looping
        try {
            let roomState = yield matrixClient.roomState(roomId);
            wholeBridgingState = roomState.find(
                (e) => {
                    return e.type === 'm.room.bridging' && e.state_key === skey
                }
            );
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

        // Bridging state exists and is either success or pending (ignore failures)
        if (wholeBridgingState && wholeBridgingState.content) {
            let bridgingState = wholeBridgingState.content;

            if (bridgingState.status !== 'failure') {
                // If bridging state sender is this bot
                if (wholeBridgingState.sender === matrixClient.credentials.userId) {
                    // Success, already pending/success
                    log.info(`Bridging state already exists in room ${roomId} ` +
                             `(status = ${bridgingState.status},` +
                             ` bridger = ${bridgingState.user_id}.)`);

                    if (bridgingState.status === 'success') {
                        // This indicates success, so check that the mapping exists in the
                        //  database

                        let entry = yield this._ircBridge.getStore()
                            .getRoom(roomId, ircDomain, ircChannel, 'provision');

                        if (!entry) {
                            // Update the bridging state to be a failure
                            log.warn(`Bridging state in room states successful mapping, `+
                                     `but the bridge is not aware of provisioning. The ` +
                                     `bridge will update the state in the room to failure ` +
                                     `and continue with the provisioning request.`);
                            yield this._updateBridgingState(roomId, userId, 'failure', skey);
                        }
                    } // If pending, resend the message to the op as if it were the original
                    else if (bridgingState.status === 'pending') {
                        // _getRequest has not returned a pending request (see previously)
                        log.warn(`Bridging state in room states pending mapping, ` +
                                 `but the bridge is not waiting for a reply from ` +
                                 `an op. The bridge will continue with the ` +
                                 `provisioning request, sending another message ` +
                                 `to the op in case the server was restarted`);
                    }
                }
                else {// If it is from a different sender, fail
                    throw new Error(`A request to create this mapping has already been sent ` +
                             `(status = ${bridgingState.status},` +
                             ` bridger = ${bridgingState.user_id}. Ignoring request.`);
                }
            }
        }

        log.info(`Sending pending m.room.bridging to ${roomId}, state key = ${skey}`);

        // (Matrix) update room state
        // Send pending m.room.bridging
        yield this._updateBridgingState(roomId, userId, 'pending', skey);

        // (IRC) Ask operator for authorisation
        // Time that operator has to respond before giving up
        let timeoutSeconds = this._requestTimeoutSeconds;

        // Deliberately not yielding on this so that 200 OK is returned
        log.info(`Contacting operator`);
        this._createAuthorisedLink(
            botClient, server, opNick, ircChannel, key,
            roomId, userId, skey, timeoutSeconds);
    }
);

Provisioner.prototype._sendToUser = Promise.coroutine(
    function*(receiverNick, server, message) {
        let botClient = yield this._getBotClientForServer(server);
        return this._ircBridge.sendIrcAction(
            new IrcRoom(server, receiverNick),
            botClient,
            new IrcAction("message", message));
    }
);

// Contact an operator, asking for authorisation for a mapping, and if they reply
//  'yes' or 'y', create the mapping.
Provisioner.prototype._createAuthorisedLink = Promise.coroutine(
    function*(botClient, server, opNick, ircChannel, key, roomId, userId, skey, timeoutSeconds) {
        let d = promiseutil.defer();

        this._setRequest(server, opNick, {userId: userId, defer: d});

        yield this._sendToUser(opNick, server,
            `${userId} has requested to bridge ${roomId} with ${ircChannel} on this IRC ` +
            `network. Respond with 'yes' or 'y' to allow, or simply ignore this message to ` +
            `disallow. You have ${timeoutSeconds} seconds from when this message was sent.`);

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
            yield this._doLink(server, ircChannel, key, roomId, userId);
        }
        catch (err) {
            log.error(err.stack);
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

Provisioner.prototype.handlePm = Promise.coroutine(function*(server, fromUser, text) {
    if (['y', 'yes'].indexOf(text.trim().toLowerCase()) == -1) {
        log.warn(`Provisioner only handles text 'yes'/'y' ` +
                 `(from ${fromUser.nick} on ${server.domain})`);

        yield this._sendToUser(
            fromUser.nick, server,
            'Please respond with "yes" or "y".'
        );
        return;
    }
    let request = this._getRequest(server, fromUser.nick);
    if (request) {
        log.info(`${fromUser.nick} has authorised a new provisioning`);
        request.defer.resolve();

        yield this._sendToUser(
            fromUser.nick, server,
            'Thanks for your response, bridge request authorised.'
        );

        return;
    }
    log.warn(`Provisioner was not expecting PM from ${fromUser.nick} on ${server.domain}`);
    yield this._sendToUser(
        fromUser.nick, server,
        'The bot was not expecting a message from you. You might have already replied to a request.'
    );
});

// Get information that might be useful prior to calling requestLink
//  returns
//  {
//   operators: ['operator1', 'operator2',...] // an array of IRC chan op nicks
//  }
Provisioner.prototype.queryLink = Promise.coroutine(function*(options) {
    let ircDomain = options.remote_room_server;
    let ircChannel = options.remote_room_channel;
    let key = options.key || undefined; // Optional key

    let queryInfo = {
        // Array of operator nicks
        operators: []
    };

    try {
        this._queryLinkValidator.validate(options);
    }
    catch (err) {
        // .validate does not return any details of problems with parameters
        log.error(err.stack);
        throw new Error(`Parameter(s) malformed`);
    }

    // Try to find the domain requested for linking
    //TODO: ircDomain might include protocol, i.e. irc://irc.freenode.net
    let server = this._ircBridge.getServer(ircDomain);

    if (!server) {
        throw new Error(`Server not found ${ircDomain}`);
    }

    if (server.isExcludedChannel(ircChannel)) {
        throw new Error(`Server is configured to exclude channel ${ircChannel}`);
    }

    let botClient = yield this._getBotClientForServer(server);

    let opsInfo = null;

    try {
        opsInfo = yield botClient.getOperators(ircChannel, key);
    }
    catch (err) {
        log.error(err.stack);
        throw new Error(`Failed to get operators for channel ${ircChannel}`);
    }

    queryInfo.operators = opsInfo.operatorNicks;

    // Exclude the bot, which has to join to get the operators
    queryInfo.operators = queryInfo.operators.filter(
        (nick) => {
            return nick !== botClient.nick;
        }
    );

    return queryInfo;
});

// Get the list of currently configured networks (from the config)
Provisioner.prototype.queryNetworks = Promise.coroutine(function*() {
    return {
        servers: this._ircBridge.ircServers.map((server) => {return server.domain})
    };
});

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
            // TODO: Provide more interesting errors back to the requester
            throw new Error('Failed to authorise provisioning');
        }
    }
    else {
        throw new Error(`Room mapping already exists (${mappingLogId},` +
                        `origin = ${entry.data.origin})`);
    }
});

Provisioner.prototype._doLink = Promise.coroutine(
    function*(server, ircChannel, key, roomId, userId) {
        let ircDomain = server.domain;
        let mappingLogId = `${roomId} <---> ${ircDomain}/${ircChannel}`;
        log.info(`Provisioning link for room ${mappingLogId}`);

        // Create rooms for the link
        let ircRoom = new IrcRoom(server, ircChannel);
        let mxRoom = new MatrixRoom(roomId);

        let entry = yield this._ircBridge.getStore().getRoom(roomId, ircDomain, ircChannel);
        if (entry) {
            throw new Error(`Room mapping already exists (${mappingLogId},` +
                            `origin = ${entry.data.origin})`);
        }
        yield this._ircBridge.getStore().storeRoom(ircRoom, mxRoom, 'provision');

        // Cause the bot to join the new plumbed channel (if it is enabled (see joinChannel))
        // TODO: key not persisted on restart
        let botClient = yield this._getBotClientForServer(server);
        yield botClient.joinChannel(ircChannel, key);

        try {
            // Cause the provisioner to join the IRC channel
            var req = new BridgeRequest(
                this._ircBridge._bridge.getRequestFactory().newRequest(), false
            );
            var target = new MatrixUser(userId);
            // inject a fake join event which will do M->I connections and
            // therefore sync the member list
            yield this._ircBridge.matrixHandler.onJoin(req, {
                event_id: "$fake:membershiplist",
                room_id: roomId,
                state_key: userId,
                user_id: userId,
                content: {
                    membership: "join"
                },
                _injected: true,
                _frontier: true,
            }, target);
        }
        catch (err) {
            // Not fatal, so log error and return success
            log.error(err);
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

    if (!entry) {
        throw new Error(`Provisioned room mapping does not exist (${mappingLogId})`);
    }
    yield this._ircBridge.getStore().removeRoom(roomId, ircDomain, ircChannel, 'provision');

    // Cause the bot to part the channel if there are no other rooms being mapped to this channel
    //  (and if it is enabled (see leaveChannel))

    yield mappings = this._ircBridge.getStore().getMatrixRoomsForChannel(ircChannel);
    if (mappings.length === 0) {
        let botClient = yield this._getBotClientForServer(server);
        yield botClient.leaveChannel(ircChannel);
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
