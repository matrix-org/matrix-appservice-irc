/*eslint no-invalid-this: 0*/ // eslint doesn't understand Promise.coroutine wrapping
"use strict";
const Promise = require("bluebird");
const IrcRoom = require("../models/IrcRoom");
const IrcAction = require("../models/IrcAction");
const MatrixRoom = require("matrix-appservice-bridge").MatrixRoom;
const ConfigValidator = require("matrix-appservice-bridge").ConfigValidator;
const MatrixUser = require("matrix-appservice-bridge").MatrixUser;
const BridgeRequest = require("../models/BridgeRequest");
const ProvisionRequest = require("./ProvisionRequest");

const log = require("../logging").get("Provisioner");
const promiseutil = require("../promiseutil.js");

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
            "remote_room_server",
            "user_id"
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
                res.status(500);
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

    let createProvisionEndpoint = (fn, fnName) => {
        return Promise.coroutine(function*(req, res) {
            req = new ProvisionRequest(req, fnName);
            req.log.info(
                'New provisioning request: ' + JSON.stringify(req.body) +
                ' params: ' + JSON.stringify(req.params)
            );
            try {
                let result = yield fn.call(self, req);
                if (!result) {
                    result = {};
                }
                req.log.info(`Sending result: ${JSON.stringify(result)}`);
                res.json(result);
            }
            catch (err) {
                res.status(500).json({error: err.message});
                req.log.error(err.stack);
                throw err;
            }
        });
    };

    as.app.post("/_matrix/provision/link",
        createProvisionEndpoint(this.requestLink, 'requestLink')
    );

    as.app.post("/_matrix/provision/unlink",
        createProvisionEndpoint(this.unlink, 'unlink')
    );

    as.app.get("/_matrix/provision/listlinks/:roomId",
        createProvisionEndpoint(this.listings, 'listings')
    );

    as.app.post("/_matrix/provision/querylink",
        createProvisionEndpoint(this.queryLink, 'queryLink')
    );

    as.app.get("/_matrix/provision/querynetworks",
        createProvisionEndpoint(this.queryNetworks, 'queryNetworks')
    );

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

Provisioner.prototype._updateBridgingState = Promise.coroutine(
    function*(req, roomId, userId, status, skey) {
        let intent = this._ircBridge.getAppServiceBridge().getIntent();
        try {
            yield intent.client.sendStateEvent(roomId, 'm.room.bridging', {
                user_id: userId,
                status: status // pending, success, failure
            }, skey);
        }
        catch (err) {
            throw new Error(`Could not update m.room.bridging state in this room`);
        }
    }
);

// Utility function for attempting to send a request to a matrix endpoint
//  that might be rate-limited.
//
//  This function will try `attempts` times to apply function `fn` to `obj` by
//  calling fn.apply(obj, args), with args being any arguments passed to retry
//  after `fn`. If an error occurs, the same will be tried again after
//  `retryDelayMs`. If an error err is thrown by `fn` and err.data.retry_after_ms
//  is set, it will be added to that delay.
//
//  If the number of attempts is reached, an error is thrown.
let retry = Promise.coroutine(function*(req, attempts, retryDelayMS, obj, fn) {
    // Remove first 5 args
    var args = Array.from(arguments).slice(5);

    for (;attempts > 0; attempts--) {
        try {
            let val = yield fn.apply(obj, args);
            return val;
        }
        catch (err) {
            let msg = err.data && err.data.error ? err.data.error : err.message;
            req.log.error(`Error doing rate limited action (${msg})`);

            let waitTimeMs = retryDelayMS;

            if (err.data && err.data.retry_after_ms && attempts > 0) {
                waitTimeMs += err.data.retry_after_ms;
            }
            yield Promise.delay(waitTimeMs);
        }
    }

    throw new Error(`Too many attempts to do rate limited action`);
});

Provisioner.prototype._userHasProvisioningPower = Promise.coroutine(
    function*(req, userId, roomId) {
        req.log.info(`Check power level of ${userId} in room ${roomId}`);
        let matrixClient = this._ircBridge.getAppServiceBridge().getClientFactory().getClientAs();

        let powerState = null;

        // Try 100 times to join a room, or timeout after 10 min
        yield retry(req, 100, 5000, matrixClient, matrixClient.joinRoom, roomId).timeout(600000);
        try {
            yield this._ircBridge.getAppServiceBridge().canProvisionRoom(roomId);
        }
        catch (err) {
            req.log.error(`Room failed room validator check: (${err})`);
            throw new Error(
                'Room failed validation. You may be attempting to "double bridge" this room.' +
                ' Error: ' + err
            );
        }

        try {
            powerState = yield matrixClient.getStateEvent(roomId, 'm.room.power_levels');
        }
        catch (err) {
            req.log.error(`Error retrieving power levels (${err.data.error})`);
            throw new Error('Could not retrieve your power levels for the room');
        }

        // In 10 minutes
        setTimeout(() => {
            this._leaveMatrixRoomIfUnprovisioned(req, roomId);
        }, 10 * 60 * 1000);

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
    function*(req, server, userId, ircChannel, roomId, opNick, key) {
        let ircDomain = server.domain;

        let existing = this._getRequest(server, opNick);
        if (existing) {
            let from = existing.userId;
            throw new Error(`Bridging request already sent to `+
                            `${opNick} on ${server.domain} from ${from}`);
        }

        // (Matrix) Check power level of user
        let hasPower = yield this._userHasProvisioningPower(req, userId, roomId);
        if (!hasPower) {
            throw new Error('User does not possess high enough power level');
        }

        // (IRC) Check that op's nick is actually op
        req.log.info(`Check that op's nick is actually op`);

        let botClient = yield this._ircBridge.getBotClient(server);

        let info = yield botClient.getOperators(ircChannel, {key : key});

        if (info.nicks.indexOf(opNick) === -1) {
            throw new Error(`Provided user is not in channel ${ircChannel}.`);
        }

        if (info.operatorNicks.indexOf(opNick) === -1) {
            throw new Error(`Provided user is not an op of ${ircChannel}.`);
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
                if (wholeBridgingState.sender !== matrixClient.credentials.userId) {
                    // If it is from a different sender, fail
                    throw new Error(
                        `A request to create this mapping has already been sent ` +
                        `(status = ${bridgingState.status},` +
                        ` bridger = ${bridgingState.user_id}. Ignoring request.`
                    );
                }
                // Success, already pending/success
                req.log.info(
                    `Bridging state already exists in room ${roomId} ` +
                    `(status = ${bridgingState.status},` +
                    ` bridger = ${bridgingState.user_id}.)`
                );

                if (bridgingState.status === 'success') {
                    // This indicates success, so check that the mapping exists in the
                    //  database

                    let entry = null;
                    try {
                        entry = yield this._ircBridge.getStore()
                            .getRoom(roomId, ircDomain, ircChannel, 'provision');
                    }
                    catch (err) {
                        req.log.error(err.stack);
                        throw new Error(
                            `Error whilst checking for previously ` +
                            `successful provisioning of ` +
                            `${roomId}<-->${ircChannel}`
                        );
                    }

                    if (!entry) {
                        // Update the bridging state to be a failure
                        req.log.warn(
                            `Bridging state in room states successful mapping, `+
                            `but the bridge is not aware of provisioning. The ` +
                            `bridge will update the state in the room to failure ` +
                            `and continue with the provisioning request.`
                        );
                        try {
                            yield this._updateBridgingState(req, roomId, userId, 'failure', skey);
                        }
                        catch (err) {
                            req.log.error(err.stack);
                            throw new Error(
                                `Bridging state success and mapping does not ` +
                                `exist, but could not update bridging state ` +
                                `${skey} of ${roomId} to failure.`
                            );
                        }
                    }
                } // If pending, resend the message to the op as if it were the original
                else if (bridgingState.status === 'pending') {
                    // _getRequest has not returned a pending request (see previously)
                    req.log.warn(
                        `Bridging state in room states pending mapping, ` +
                        `but the bridge is not waiting for a reply from ` +
                        `an op. The bridge will continue with the ` +
                        `provisioning request, sending another message ` +
                        `to the op in case the server was restarted`
                    );
                }
            }
        }

        req.log.info(`Sending pending m.room.bridging to ${roomId}, state key = ${skey}`);

        // (Matrix) update room state
        // Send pending m.room.bridging
        yield this._updateBridgingState(req, roomId, userId, 'pending', skey);

        // (IRC) Ask operator for authorisation
        // Time that operator has to respond before giving up
        let timeoutSeconds = this._requestTimeoutSeconds;

        // Deliberately not yielding on this so that 200 OK is returned
        req.log.info(`Contacting operator`);
        this._createAuthorisedLink(
            req, botClient, server, opNick, ircChannel, key,
            roomId, userId, skey, timeoutSeconds);
    }
);

Provisioner.prototype._sendToUser = Promise.coroutine(
    function*(receiverNick, server, message) {
        let botClient = yield this._ircBridge.getBotClient(server);
        return this._ircBridge.sendIrcAction(
            new IrcRoom(server, receiverNick),
            botClient,
            new IrcAction("message", message));
    }
);

// Contact an operator, asking for authorisation for a mapping, and if they reply
//  'yes' or 'y', create the mapping.
Provisioner.prototype._createAuthorisedLink = Promise.coroutine(function*
    (req, botClient, server, opNick, ircChannel, key, roomId, userId, skey, timeoutSeconds) {
        let d = promiseutil.defer();

        this._setRequest(server, opNick, {userId: userId, defer: d, log: req.log});

        // Get room name
        let matrixClient = this._ircBridge.getAppServiceBridge().getClientFactory().getClientAs();

        let nameState = null;
        try {
            nameState = yield matrixClient.getStateEvent(roomId, 'm.room.name');
        }
        catch (err) {
            if (err.stack && err.message) {
                req.log.error(`Error retrieving room name (${err.message})`);
                req.log.error(err.stack);
            }
            else if (err.data.error) {
                req.log.error(`Error retrieving room name (${err.data.error})`);
            }
            else {
                req.log.error(`Error retrieving name`);
                req.log.error(err);
            }
        }

        // Get canonical alias
        let aliasState = null;
        try {
            aliasState = yield matrixClient.getStateEvent(roomId, 'm.room.canonical_alias');
        }
        catch (err) {
            if (err.stack && err.message) {
                req.log.error(`Error retrieving alias (${err.message})`);
                req.log.error(err.stack);
            }
            else if (err.data.error) {
                req.log.error(`Error retrieving alias (${err.data.error})`);
            }
            else {
                req.log.error(`Error retrieving alias`);
                req.log.error(err);
            }
        }

        let roomDesc = null;
        let matrixToLink = `https://matrix.to/#/${roomId}`;

        if (aliasState && aliasState.alias) {
            roomDesc = aliasState.alias;
            matrixToLink = `https://matrix.to/#/${aliasState.alias}`;
        }

        if (nameState && nameState.name) {
            roomDesc = `'${nameState.name}'`;
        }

        if (roomDesc) {
            roomDesc = `${roomDesc} (${matrixToLink})`;
        }
        else {
            roomDesc = `${matrixToLink}`;
        }

        yield this._sendToUser(opNick, server,
            `${userId} has requested to bridge ${roomDesc} with ${ircChannel} on this IRC ` +
            `network. Respond with 'yes' or 'y' to allow, or simply ignore this message to ` +
            `disallow. You have ${timeoutSeconds} seconds from when this message was sent.`);

        try {
            yield d.promise.timeout(timeoutSeconds * 1000);
            this._removeRequest(server, opNick);
        }
        catch (err) {
            req.log.info(`Operator ${opNick} did not respond (${err.message})`);
            yield this._updateBridgingState(req, roomId, userId, 'failure', skey);
            this._removeRequest(server, opNick);
            return;
        }
        try {
            yield this._doLink(req, server, ircChannel, key, roomId, userId);
        }
        catch (err) {
            req.log.error(err.stack);
            req.log.info(`Failed to create link following authorisation (${err.message})`);
            yield this._updateBridgingState(req, roomId, userId, 'failure', skey);
            this._removeRequest(server, opNick);
            return;
        }
        yield this._updateBridgingState(req, roomId, userId, 'success', skey);
    }
);

Provisioner.prototype._removeRequest = function (server, opNick) {
    if (this._pendingRequests[server.domain]) {
        delete this._pendingRequests[server.domain][opNick];
    }
}

// Returns a pending request if it's promise isPending(), otherwise null
Provisioner.prototype._getRequest = function (server, opNick) {
    let reqs = this._pendingRequests[server.domain];
    if (reqs) {
        if (!reqs[opNick]) {
            return null;
        }

        if (reqs[opNick].defer.promise.isPending()) {
            return reqs[opNick];
        }
    }
    return null;
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
        request.log.info(`${fromUser.nick} has authorised a new provisioning`);
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

// Using ISUPPORT rules supported by MatrixBridge bot, case map ircChannel
function caseFold(cli, channel) {
    if (!cli.unsafeClient) {
        log.warn(`Could not case map ${channel} - BridgedClient has no IRC client`);
        return channel;
    }
    return cli.unsafeClient._toLowerCase(channel);
}

// Get information that might be useful prior to calling requestLink
//  returns
//  {
//   operators: ['operator1', 'operator2',...] // an array of IRC chan op nicks
//  }
Provisioner.prototype.queryLink = Promise.coroutine(function*(req) {
    let options = req.body;
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
        if (err._validationErrors) {
            let s = err._validationErrors.map((e)=>{
                return `${e.field} is malformed`;
            }).join(', ');
            throw new Error(s);
        }
        else {
            log.error(err);
            // change the message and throw
            throw new Error('Malformed parameters');
        }
    }

    // Try to find the domain requested for linking
    //TODO: ircDomain might include protocol, i.e. irc://irc.freenode.net
    let server = this._ircBridge.getServer(ircDomain);

    if (!server) {
        throw new Error(`Server not found ${ircDomain}`);
    }

    let botClient = yield this._ircBridge.getBotClient(server);

    ircChannel = caseFold(botClient, ircChannel);

    if (server.isExcludedChannel(ircChannel)) {
        throw new Error(`Server is configured to exclude channel ${ircChannel}`);
    }

    let opsInfo = null;

    try {
        opsInfo = yield botClient.getOperators(ircChannel,
            {
                key: key,
                cacheDurationMs: 1000 * 60 * 5
            }
        );
    }
    catch (err) {
        req.log.error(err.stack);
        throw new Error(`Failed to get operators for channel ${ircChannel} (${err.message})`);
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

// Get the list of currently network instances
Provisioner.prototype.queryNetworks = Promise.coroutine(function*() {
    let thirdParty = yield this._ircBridge.getThirdPartyProtocol();

    return {
        servers: thirdParty.instances
    };
});

// Link an IRC channel to a matrix room ID
Provisioner.prototype.requestLink = Promise.coroutine(function*(req) {
    let options = req.body;
    try {
        this._linkValidator.validate(options);
    }
    catch (err) {
        if (err._validationErrors) {
            let s = err._validationErrors.map((e)=>{
                return `${e.field} is malformed`;
            }).join(', ');
            throw new Error(s);
        }
        else {
            log.error(err);
            // change the message and throw
            throw new Error('Malformed parameters');
        }
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

    let botClient = yield this._ircBridge.getBotClient(server);

    ircChannel = caseFold(botClient, ircChannel);

    if (server.isExcludedChannel(ircChannel)) {
        throw new Error(`Server is configured to exclude given channel ('${ircChannel}')`);
    }

    let entry = yield this._ircBridge.getStore().getRoom(roomId, ircDomain, ircChannel);
    if (!entry) {
        // Ask OP for provisioning authentication
        yield this._authoriseProvisioning(req, server, userId, ircChannel, roomId, opNick, key);
    }
    else {
        throw new Error(`Room mapping already exists (${mappingLogId},` +
                        `origin = ${entry.data.origin})`);
    }
});

Provisioner.prototype._doLink = Promise.coroutine(
    function*(req, server, ircChannel, key, roomId, userId) {
        let ircDomain = server.domain;
        let mappingLogId = `${roomId} <---> ${ircDomain}/${ircChannel}`;
        req.log.info(`Provisioning link for room ${mappingLogId}`);

        // Create rooms for the link
        let ircRoom = new IrcRoom(server, ircChannel);
        let mxRoom = new MatrixRoom(roomId);

        let entry = yield this._ircBridge.getStore().getRoom(roomId, ircDomain, ircChannel);
        if (entry) {
            throw new Error(`Room mapping already exists (${mappingLogId},` +
                            `origin = ${entry.data.origin})`);
        }

        // Cause the bot to join the new plumbed channel if it is enabled
        // TODO: key not persisted on restart
        if (server.isBotEnabled()) {
            let botClient = yield this._ircBridge.getBotClient(server);
            yield botClient.joinChannel(ircChannel, key);
        }

        yield this._ircBridge.getStore().storeRoom(ircRoom, mxRoom, 'provision');

        try {
            // Cause the provisioner to join the IRC channel
            var bridgeReq = new BridgeRequest(
                this._ircBridge._bridge.getRequestFactory().newRequest(), false
            );
            var target = new MatrixUser(userId);
            // inject a fake join event which will do M->I connections and
            // therefore sync the member list
            yield this._ircBridge.matrixHandler.onJoin(bridgeReq, {
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
            req.log.error(err);
        }
    }
);

// Unlink an IRC channel from a matrix room ID
Provisioner.prototype.unlink = Promise.coroutine(function*(req) {
    let options = req.body;
    try {
        this._unlinkValidator.validate(options);
    }
    catch (err) {
        if (err._validationErrors) {
            let s = err._validationErrors.map((e)=>{
                return `${e.instanceContext} is malformed`;
            }).join(', ');
            throw new Error(s);
        }
        else {
            log.error(err);
            // change the message and throw
            throw new Error('Malformed parameters');
        }
    }

    let ircDomain = options.remote_room_server;
    let ircChannel = options.remote_room_channel;
    let roomId = options.matrix_room_id;
    let mappingLogId = `${roomId} <-/-> ${ircDomain}/${ircChannel}`;

    req.log.info(`Provisioning unlink for room ${mappingLogId}`);

    // Try to find the domain requested for unlinking
    let server = this._ircBridge.getServer(ircDomain);

    if (!server) {
        throw new Error("Server requested for linking not found");
    }

    // Make sure the requester is a mod in the room
    let botCli = this._ircBridge.getAppServiceBridge().getBot().getClient();
    let stateEvents = yield botCli.roomState(roomId);
    // user_id must be JOINED and must have permission to modify power levels
    let isJoined = false;
    let hasPower = false;
    stateEvents.forEach((e) => {
        if (e.type === "m.room.member" && e.state_key === options.user_id) {
            isJoined = e.content.membership === "join";
        }
        else if (e.type == "m.room.power_levels" && e.state_key === "") {
            let powerRequired = e.content.state_default;
            if (e.content.events && e.content.events["m.room.power_levels"]) {
                powerRequired = e.content.events["m.room.power_levels"];
            }
            let power = e.content.users_default;
            if (e.content.users && e.content.users[options.user_id]) {
                power = e.content.users[options.user_id];
            }
            hasPower = power >= powerRequired;
        }
    });
    if (!isJoined) {
        throw new Error(`${options.user_id} is not in the room`);
    }
    if (!hasPower) {
        throw new Error(`${options.user_id} is not a moderator in the room.`);
    }


    // Delete the room link
    let entry = yield this._ircBridge.getStore()
        .getRoom(roomId, ircDomain, ircChannel, 'provision');

    if (!entry) {
        throw new Error(`Provisioned room mapping does not exist (${mappingLogId})`);
    }
    yield this._ircBridge.getStore().removeRoom(roomId, ircDomain, ircChannel, 'provision');

    // Leaving rooms should not cause unlink to fail
    try {
        yield this._leaveIfUnprovisioned(req, roomId, server, ircChannel);
    }
    catch (err) {
        req.log.error(err.stack);
    }
});

// Force the bot to leave both sides of a provisioned mapping if there are no more mappings that
//  map either the channel or room. Force IRC clients to part the channel.
Provisioner.prototype._leaveIfUnprovisioned = Promise.coroutine(
    function*(req, roomId, server, ircChannel) {
        try {
            yield Promise.all([
                this._partUnlinkedIrcClients(req, roomId, server, ircChannel),
                this._leaveMatrixVirtuals(req, roomId, server, ircChannel)
            ]);
        }
        catch (err) {
            // keep going, we still need to part the bot; this is just cleanup
            req.log.error(err.stack);
        }

        // Cause the bot to part the channel if there are no other rooms being mapped to this
        // channel
        let mxRooms = yield this._ircBridge.getStore().getMatrixRoomsForChannel(server, ircChannel);
        if (mxRooms.length === 0) {
            let botClient = yield this._ircBridge.getBotClient(server);
            req.log.info(`Leaving channel ${ircChannel} as there are no more provisioned mappings`);
            yield botClient.leaveChannel(ircChannel);
        }

        yield this._leaveMatrixRoomIfUnprovisioned(req, roomId);
    }
);

// Parts IRC clients who should no longer be in the channel as a result of the given mapping being
// unlinked.
Provisioner.prototype._partUnlinkedIrcClients = Promise.coroutine(
    function*(req, roomId, server, ircChannel) {
        // Get the full set of room IDs linked to this #channel
        let matrixRooms = yield this._ircBridge.getStore().getMatrixRoomsForChannel(
            server, ircChannel
        );
        // make sure the unlinked room exists as we may have just removed it
        let exists = false;
        for (let i = 0; i < matrixRooms.length; i++) {
            if (matrixRooms[i].getId() === roomId) {
                exists = true;
                break;
            }
        }
        if (!exists) {
            matrixRooms.push(new MatrixRoom(roomId));
        }


        // For each room, get the list of real matrix users and tally up how many times each one
        // appears as joined
        const joinedUserCounts = {}; // user_id => Number
        let unlinkedUserIds = [];
        const asBot = this._ircBridge.getAppServiceBridge().getBot();
        for (let i = 0; i < matrixRooms.length; i++) {
            let stateEvents = [];
            try {
                stateEvents = yield asBot.getClient().roomState(matrixRooms[i].getId());
            }
            catch (err) {
                req.log.error("Failed to hit /state for room " + matrixRooms[i].getId());
                req.log.error(err.stack);
            }

            // _getRoomInfo takes a particular format.
            const joinedRoom = {
                state: {
                    events: stateEvents
                }
            }
            let roomInfo = asBot._getRoomInfo(matrixRooms[i].getId(), joinedRoom);
            for (let j = 0; j < roomInfo.realJoinedUsers.length; j++) {
                let userId = roomInfo.realJoinedUsers[j];
                if (!joinedUserCounts[userId]) {
                    joinedUserCounts[userId] = 0;
                }
                joinedUserCounts[userId] += 1;

                if (matrixRooms[i].getId() === roomId) { // the unlinked room
                    unlinkedUserIds.push(userId);
                }
            }
        }

        // Decrement counters for users who are in the unlinked mapping
        // as they are now "leaving". Part clients which have a tally of 0.
        unlinkedUserIds.forEach((userId) => {
            joinedUserCounts[userId] -= 1;
        });
        let partUserIds = Object.keys(joinedUserCounts).filter((userId) => {
            return joinedUserCounts[userId] === 0;
        });
        partUserIds.forEach((userId) => {
            req.log.info(`Parting user ${userId} from ${ircChannel} as mapping unlinked.`);
            let cli = this._ircBridge.getIrcUserFromCache(server, userId);
            if (!cli) {
                return; // client is disconnected
            }
            cli.leaveChannel(ircChannel, "Unlinked");
        });
        req.log.info(
            `Unlinked user_id tallies for ${ircChannel}: ${JSON.stringify(joinedUserCounts)}`
        );
    }
);

Provisioner.prototype._leaveMatrixVirtuals = Promise.coroutine(
    function*(req, roomId, server, ircChannel) {
        const asBot = this._ircBridge.getAppServiceBridge().getBot();
        const roomChannels = yield this._ircBridge.getStore().getIrcChannelsForRoomId(
            roomId
        );
        if (roomChannels.length > 0) {
            // We can't determine who should and shouldn't be in the room.
            return;
        }
        const stateEvents = yield asBot.getClient().roomState(roomId);
        const roomInfo = asBot._getRoomInfo(roomId, {
            state: {
                events: stateEvents
            }
        });
        req.log.info(`Leaving ${roomInfo.remoteJoinedUsers.length} virtual users from ${roomId}.`);
        this._ircBridge.memberListSyncers[server.domain].addToLeavePool(
            roomInfo.remoteJoinedUsers,
            roomId,
            ircChannel
        );
    }
);

// Cause the bot to leave the matrix room if there are no other channels being mapped to
// this room
Provisioner.prototype._leaveMatrixRoomIfUnprovisioned = Promise.coroutine(
    function*(req, roomId) {
        let ircChannels = yield this._ircBridge.getStore().getIrcChannelsForRoomId(roomId);
        if (ircChannels.length === 0) {
            let matrixClient = this._ircBridge.getAppServiceBridge()
                                              .getClientFactory().getClientAs();
            req.log.info(`Leaving room ${roomId} as there are no more provisioned mappings`);
            yield matrixClient.leave(roomId);
        }
    }
);

// List all mappings currently provisioned with the given matrix_room_id
Provisioner.prototype.listings = function(req) {
    let roomId = req.params.roomId;
    try {
        this._roomIdValidator.validate({"matrix_room_id": roomId});
    }
    catch (err) {
        if (err._validationErrors) {
            let s = err._validationErrors.map((e)=>{
                return `${e.instanceContext} is malformed`;
            }).join(', ');
            throw new Error(s);
        }
        else {
            log.error(err);
            // change the message and throw
            throw new Error('Malformed parameters');
        }
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
