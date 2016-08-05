/*eslint no-invalid-this: 0*/ // eslint doesn't understand Promise.coroutine wrapping
"use strict";
var Promise = require("bluebird");
var IrcRoom = require("../models/IrcRoom");
var MatrixRoom = require("matrix-appservice-bridge").MatrixRoom;

var log = require("../logging").get("Provisioner");

function Provisioner(ircBridge) {
    this._ircBridge = ircBridge;

    let as = this._ircBridge.getAppServiceBridge().appService;
    let self = this;

    as.app.post("/_matrix/provision/link", Promise.coroutine(function*(req, res) {
        try {
            self.validate(req.body);
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
            self.validate(req.body);
            yield self.unlink(req.body);
            res.json({});
        }
        catch (err) {
            res.status(500).json({error: err.message});
            throw err;
        }
    }));
}

var parameterValidation = {
    matrix_room_id :
        {regex : /^!.*:.*$/, example : '!Abcdefg:example.com[:8080]'},
    remote_room_channel :
        {regex : /^([#+&]|(![A-Z0-9]{5}))[^\s:,]+$/, example : '#roomname'},
    remote_room_server :
        {regex : /^[a-z\.0-9:-]+$/, example : 'example.com or localhost'},
};

Provisioner.prototype.validate = function(parameters) {
    let parameterNames = ['matrix_room_id', 'remote_room_channel', 'remote_room_server'];
    for (var i = 0; i < parameterNames.length; i++) {
        let name = parameterNames[i];

        let actual = parameters[name];
        let valid = parameterValidation[name];

        if (!actual) {
            throw new Error(
                `${name} not provided (like '${valid.example}').`
            );
        }

        if (typeof actual !== 'string') {
            throw new Error(
                `${name} should be a string (like '${valid.example}').`
            );
        }

        if (!actual.match(valid.regex)) {
            throw new Error(
                `Malformed ${name} ('${actual}'), should look like '${valid.example}'.`
            );
        }
    }
};

// Link an IRC channel to a matrix room ID
Provisioner.prototype.link = Promise.coroutine(function*(options) {
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

    // Create rooms for the link
    let ircRoom = new IrcRoom(server, ircChannel);
    let mxRoom = new MatrixRoom(roomId);

    let entry = yield this._ircBridge.getStore().getRoom(roomId, ircDomain, ircChannel);
    if (!entry) {
        yield this._ircBridge.getStore().storeRoom(ircRoom, mxRoom, 'provision');
    }
    else {
        throw new Error(`Room mapping already exists (${mappingLogId},` +
                        `origin = ${doc.data.origin})`);
    }
});

// Unlink an IRC channel from a matrix room ID
Provisioner.prototype.unlink = Promise.coroutine(function*(options) {
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

module.exports = Provisioner;
