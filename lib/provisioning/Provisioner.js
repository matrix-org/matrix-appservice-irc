"use strict";
var Promise = require("bluebird");
var IrcRoom = require("../models/IrcRoom");
var MatrixRoom = require("matrix-appservice-bridge").MatrixRoom;

var log = require("../logging").get("Provisioner");

function Provisioner(ircBridge) {
    this._ircBridge = ircBridge;

    let as = this._ircBridge.getAppServiceBridge().appService;

    
    as.app.post("/_matrix/provision/link", (req, res) => {
        this.validate(req.body).then(
            ()  => { res.json({}) },
            (err) => { res.status(500).json({error: err.message}) }
        ).then(
            ()  => { this.link(req.body) },
            (err) => { res.status(500).json({error: err.message}) }
        );
    });

    as.app.post("/_matrix/provision/unlink", (req, res) => {
        this.validate(req.body).then(
            ()  => { res.json({}) },
            (err) => { res.status(500).json({error: err.message}) }
        ).then(
            ()  => { this.unlink(req.body) },
            (err) => { res.status(500).json({error: err.message}) }
        );
    });
};

var parameterRegexes = {
    matrix_room_id : /^![0-9A-Za-z]+?:[^:]+(\:[0-9]+)?$/,
    remote_room_channel : /^#.+$/,
    remote_room_server : /^[a-z\.]+$/
};

var parameterExamples = {
    matrix_room_id : '!Abcdefg:example.com[:8080]',
    remote_room_channel : '#roomname',
    remote_room_server : 'example.com or localhost'
};

Provisioner.prototype.validate = Promise.coroutine(function*(parameters) {
    for (var name in parameters) {
        let actual = parameters[name];

        if (!actual.match(parameterRegexes[name])) {
            let example = parameterExamples[name];
            throw new Error(`Malformed ${name} ('${actual}'), should look like '${example}'.`);
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