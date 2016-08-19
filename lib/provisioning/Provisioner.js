/*eslint no-invalid-this: 0*/ // eslint doesn't understand Promise.coroutine wrapping
"use strict";
var Promise = require("bluebird");
var IrcRoom = require("../models/IrcRoom");
var IrcAction = require("../models/IrcAction");
var MatrixRoom = require("matrix-appservice-bridge").MatrixRoom;
var StateLookup = require('matrix-appservice-bridge').StateLookup;

var log = require("../logging").get("Provisioner");
var promiseutil = require("../promiseutil.js");

function Provisioner(ircBridge, enabled) {
    this._ircBridge = ircBridge;
    this._enabled = enabled;
    this._expectations = [];

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

var parameterValidation = {
    matrix_room_id :
        {regex : /^!.*:.*$/, example : '!Abcdefg:example.com[:8080]'},
    remote_room_channel :
        {regex : /^([#+&]|(![A-Z0-9]{5}))[^\s:,]+$/, example : '#roomname'},
    remote_room_server :
        {regex : /^[a-z\.0-9:-]+$/, example : 'example.com or localhost'},
    op_nick :
        {regex : /^.+$/, example : 'bob'},
    key :
        {regex : /^.+$/, example : '1234567890', optional : true}
};

Provisioner.prototype._validate = function(actual, parameterName) {
    let valid = parameterValidation[parameterName];

    if (!valid) {
        throw new Error(
            `Parameter name not recognised (${parameterName}).`
        );
    }

    if (!actual) {
        if (valid.optional) {
            return;
        }
        throw new Error(
            `${parameterName} not provided (like '${valid.example}').`
        );
    }

    if (typeof actual !== 'string') {
        throw new Error(
            `${parameterName} should be a string (like '${valid.example}').`
        );
    }

    if (!actual.match(valid.regex)) {
        throw new Error(
            `Malformed ${parameterName} ('${actual}'), should look like '${valid.example}'.`
        );
    }
};

// Validate parameters for use in linking/unlinking
Provisioner.prototype._validateAll = function(parameters, parameterNames) {
    if (!parameterNames) {
        parameterNames = [
            'matrix_room_id',
            'remote_room_channel',
            'remote_room_server',
            'op_nick',
            'key'
        ];
    }
    for (var i = 0; i < parameterNames.length; i++) {
        this._validate(parameters[parameterNames[i]], parameterNames[i]);
    }
};

Provisioner.prototype._updateBridgingState = Promise.coroutine(
    function*(roomId, bridger, status, skey) {
        let intent = this._ircBridge.getAppServiceBridge().getIntent();
        try {
            yield intent.client.sendStateEvent(roomId, 'm.room.bridging', {
                bridger: bridger,
                status: status // pending, success, failure
            }, skey);
        }
        catch (err) {
            throw new Error(`Could not update m.room.bridging state in this room ($err.message)`);
        }
    }
);

Provisioner.prototype._authoriseProvisioning = Promise.coroutine(
    function*(server, bridger, ircChannel, roomId, opNick, key) {
        let ircDomain = server.domain;

        // (Matrix) Check power level of user
        let matrixClient = this._ircBridge.getAppServiceBridge().getClientFactory().getClientAs();
        var lookup = new StateLookup({
            client : matrixClient,
            eventTypes: ['m.room.power_levels']
        });

        yield lookup.trackRoom(roomId);

        let powerState = lookup.getState(
            roomId,
            'm.room.power_levels'
        )[0];

        let actualPower = powerState.content.users[bridger];
        let requiredPower = powerState.content.events["m.room.power_levels"];

        if (actualPower < requiredPower) {
            throw new Error('User does not possess high enough power level');
        }

        // (IRC) Check that op's nick is actually op
        let info = yield this._ircBridge.checkNickExists(server, opNick);

        if (!info.isOp) {
            throw new Error('Provided user is not an Op');
        }

        // (Matrix) update room state
        // State key for m.room.bridging
        let skey = `${ircDomain}${ircChannel}`;

        // Send pending m.room.bridging
        this._updateBridgingState(roomId, bridger, 'pending', skey);

        // (IRC) Ask operator for authorisation
        // Time that operator has to respond before giving up
        let timeout = 10;

        // Send PM to Bob
        let botClient = yield this._ircBridge.getBotClient(server);
        let authRequestAction = new IrcAction("message",
            `${bridger} has requested to bridge ${roomId} with ${ircChannel} on this IRC ` +
            `network. Respond with 'yes' to allow, or simply ignore this message to ` +
            `dissallow. You have ${timeout} seconds from when this message was sent.`);
        let pmRoom = yield botClient.joinChannel(opNick, key);

        // Promise to receive PM from Bob or timeout
        let opReplyPromise = this.expectPm(server, opNick, timeout);

        this._ircBridge.sendIrcAction(pmRoom, botClient, authRequestAction);

        opReplyPromise.then(
            () => {
                return this._dolink(server, ircChannel, roomId)
            }, (err) => {
                log.info(`Operator ${opNick} did not respond (${err.message})`);
                this._updateBridgingState(roomId, bridger, 'failure', skey);
                return Promise.reject(err);
            }
        ).then(
            () => {
                this._updateBridgingState(roomId, bridger, 'success', skey);
            }
        );

        return Promise.resolve();
    }
);

Provisioner.prototype._removeExpectation = function (expectation) {
    expectation.defer = null;
    this._expectations = this._expectations.filter((exp) => {
        return exp.defer !== null;
    });
}

Provisioner.prototype.expectPm = function(server, fromNick, timeout) {
    var d = promiseutil.defer();
    let existingExpectation = this._expectations.find(
        (expectation) => {
            return expectation.server.domain === server.domain &&
                   expectation.fromNick === fromNick;
        }
    );

    if (existingExpectation) {
        throw new Error(`Bridging request already sent to this op`+
                        ` (${fromNick} on ${server.domain})`);
    }

    let expectation = {server : server, fromNick : fromNick, defer: d};
    this._expectations.push(expectation);

    return d.promise.timeout(timeout * 1000).then(
        () => {this._removeExpectation(expectation)},
        (err) => {this._removeExpectation(expectation); return Promise.reject(err);}
    );
}

Provisioner.prototype.handlePm = function(server, fromUser, text) {
    if (text.trim() !== 'yes') {
        return;
    }
    let foundExpectation = this._expectations.find(
        (expectation) => {
            return expectation.server.domain === server.domain &&
                   expectation.fromNick === fromUser.nick;
        }
    );
    if (foundExpectation) {
        log.info(`${fromUser.nick} has authorised a new provisioning`);
        foundExpectation.defer.resolve();
        return;
    }
    log.warn(`Provisioner was not expecting PM from ${fromUser.nick} on ${server.domain}`);
}

// Link an IRC channel to a matrix room ID
Provisioner.prototype.requestLink = Promise.coroutine(function*(options) {
    this._validateAll(options);

    let ircDomain = options.remote_room_server;
    let ircChannel = options.remote_room_channel;
    let roomId = options.matrix_room_id;
    let opNick = options.op_nick;
    let key = options.key || undefined; // Optional key
    let bridger = options.bridger;
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
        yield this._authoriseProvisioning(server, bridger, ircChannel, roomId, opNick, key);
    }
    else {
        throw new Error(`Room mapping already exists (${mappingLogId},` +
                        `origin = ${entry.data.origin})`);
    }
});

Provisioner.prototype._dolink = Promise.coroutine(
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
    this._validateAll(options, [
        'matrix_room_id',
        'remote_room_channel',
        'remote_room_server'
    ]);

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
    this._validate(roomId, 'matrix_room_id');

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
