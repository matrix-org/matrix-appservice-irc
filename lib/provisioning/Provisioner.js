/*eslint no-invalid-this: 0*/ // eslint doesn't understand Promise.coroutine wrapping
"use strict";
var Promise = require("bluebird");
var IrcRoom = require("../models/IrcRoom");
var MatrixRoom = require("matrix-appservice-bridge").MatrixRoom;

var log = require("../logging").get("Provisioner");

function Provisioner(ircBridge) {
    this._ircBridge = ircBridge;

    let as = this._ircBridge.getAppServiceBridge().appService;

    as.app.post("/_matrix/provision/link", (req, res) => {
        return this.validate(req.body).then(
            () => { res.json({}) },
            (err) => { res.status(500).json({error: err.message}); return Promise.reject(err); }
        ).then(
            () => { return this.link(req.body) },
            (err) => { res.status(500).json({error: err.message}); return Promise.reject(err); }
        );
    });

    as.app.post("/_matrix/provision/unlink", (req, res) => {
        return this.validate(req.body).then(
            () => { res.json({}) },
            (err) => { res.status(500).json({error: err.message}); return Promise.reject(err); }
        ).then(
            () => { return this.unlink(req.body) },
            (err) => { res.status(500).json({error: err.message}); return Promise.reject(err); }
        );
    });
}

var parameterValidation = {
    matrix_room_id :
        {regex : /^![0-9A-Za-z]+?:[^:]+(\:[0-9]+)?$/, example : '!Abcdefg:example.com[:8080]'},
    remote_room_channel :
        {regex : /^#.+$/, example : '#roomname'},
    remote_room_server :
        {regex :  /^[a-z\.]+$/, example : 'example.com or localhost'},
};

Provisioner.prototype.validate = Promise.coroutine(function*(parameters) {
    let parameterNames = ['matrix_room_id', 'remote_room_channel', 'remote_room_server'];
    for (var i = 0; i < parameterNames.length; i++) {
        let name = parameterNames[i];

        let actual = parameters[name];
        let valid = parameterValidation[name];

        if (!actual.match(valid.regex)) {
            throw new Error(
                `Malformed ${name} ('${actual}'), should look like '${valid.example}'.`
            );
        }
    }
});

// Link an IRC channel to a matrix room ID
Provisioner.prototype.link = Promise.coroutine(function*(options) {
    let ircDomain = options.remote_room_server;
    let ircChannel = options.remote_room_channel;
    let roomId = options.matrix_room_id;

    log.info(`Provisioning link for room ${roomId} <---> ${ircChannel}`);

    if (!ircDomain || !ircChannel|| !roomId) {
        throw new Error("Server domain, ircChannel and room ID are required.");
    }

    // Try to find the domain requested for linking
    let server = this._ircBridge.getServer(ircDomain);

    if (!server) {
        throw new Error("Server requested for linking not found");
    }

    // Create rooms for the link
    let ircRoom = new IrcRoom(server, ircChannel);
    let mxRoom = new MatrixRoom(roomId);

    yield this._ircBridge.getStore().storeRoom(ircRoom, mxRoom, 'provision');
});

// Unlink an IRC channel from a matrix room ID
Provisioner.prototype.unlink = Promise.coroutine(function*(options) {
    let ircDomain = options.remote_room_server;
    let ircChannel = options.remote_room_channel;
    let roomId = options.matrix_room_id;

    log.info(`Provisioning unlink for room ${roomId} <-/-> ${ircChannel}`);


    if (!ircDomain || !ircChannel|| !roomId) {
        throw new Error("Server domain, ircChannel and room ID are required.");
    }

    // Try to find the domain requested for unlinking
    let server = this._ircBridge.getServer(ircDomain);

    if (!server) {
        throw new Error("Server requested for linking not found");
    }

    // Delete the room link, but don't update the bridge
    yield this._ircBridge.getStore()._roomStore.delete({
        id: roomId + " " + ircDomain + " " + ircChannel
    });
});

module.exports = Provisioner;
