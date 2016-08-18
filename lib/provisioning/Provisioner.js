/*eslint no-invalid-this: 0*/ // eslint doesn't understand Promise.coroutine wrapping
"use strict";
var Promise = require("bluebird");
var IrcRoom = require("../models/IrcRoom");
var MatrixRoom = require("matrix-appservice-bridge").MatrixRoom;

var log = require("../logging").get("Provisioner");

function Provisioner(ircBridge, enabled) {
    this._ircBridge = ircBridge;
    this._enabled = enabled;

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
            yield self.link(req.body);
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
};

Provisioner.prototype._validate = function(actual, parameterName) {
    let valid = parameterValidation[parameterName];

    if (!valid) {
        throw new Error(
            `Parameter name not recognised (${parameterName}).`
        );
    }

    if (!actual) {
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
Provisioner.prototype._validateAll = function(parameters) {
    let parameterNames = ['matrix_room_id', 'remote_room_channel', 'remote_room_server'];
    for (var i = 0; i < parameterNames.length; i++) {
        this._validate(parameters[parameterNames[i]], parameterNames[i]);
    }
};

// Link an IRC channel to a matrix room ID
Provisioner.prototype.link = Promise.coroutine(function*(options) {
    this._validateAll(options);

    let ircDomain = options.remote_room_server;
    let ircChannel = options.remote_room_channel;
    let roomId = options.matrix_room_id;
    let mappingLogId = `${roomId} <---> ${ircDomain}/${ircChannel}`;

    log.info(`Provisioning link for room ${mappingLogId}`);

    // Try to find the domain requested for linking
    //TODO: ircDomain might include protocol, i.e. irc://irc.freenode.net
    let server = this._ircBridge.getServer(ircDomain);

    if (!server) {
        throw new Error(`Server requested for linking not found ('${ircDomain}')`);
    }

    if (server.isExcludedChannel(ircChannel)) {
        throw new Error(`Server is configured to exclude given channel ('${ircChannel}')`);
    }

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
});

// Unlink an IRC channel from a matrix room ID
Provisioner.prototype.unlink = Promise.coroutine(function*(options) {
    this._validateAll(options);

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
