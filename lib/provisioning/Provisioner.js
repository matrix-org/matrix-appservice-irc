"use strict";
var Promise = require("bluebird");
var IrcRoom = require("../models/IrcRoom");
var MatrixRoom = require("matrix-appservice-bridge").MatrixRoom;

var log = require("../logging").get("Provisioner");

function Provisioner(ircBridge) {
    this._ircBridge = ircBridge;

    let as = this._ircBridge.getAppServiceBridge().appService;

    as.app.post("/_matrix/provision/link", (req, res) => {
        log.info("Provisioning link");

        let serverDomain = req.body.remote_room_server;
        let channel = req.body.remote_room_channel;
        let mxRoomId = req.body.matrix_room_id;

        this.link(serverDomain, channel, mxRoomId);
    });
};

// Link an IRC channel to a matrix room ID
Provisioner.prototype.link = Promise.coroutine(function*(serverDomain, channel, mxRoomId) {
    log.info(serverDomain, channel, mxRoomId);
    if (!serverDomain || !channel|| !mxRoomId) {
        throw new Error("Server domain, channel and room ID are required.");
    }


    // Try to find the domain requested for linking
    let server = this._ircBridge.getServer(serverDomain);

    if (!server) {
        log.error('Server requested for linking not found');
        return;
    }

    // Create rooms for the link
    let ircRoom = new IrcRoom(server, channel);
    let mxRoom = new MatrixRoom(mxRoomId);

    yield this._ircBridge.getStore().storeRoom(ircRoom, mxRoom, false);
});

module.exports = Provisioner;