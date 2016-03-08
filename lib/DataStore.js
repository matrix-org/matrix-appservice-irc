"use strict";

var Promise = require("bluebird");
var promiseutil = require("./promiseutil");

var IrcRoom = require("./models/IrcRoom");
var MatrixRoom = require("matrix-appservice-bridge").MatrixRoom;
var MatrixUser = require("matrix-appservice-bridge").MatrixUser;
var IrcUser = require("./models/IrcUser");
var log = require("./logging").get("database");
var toIrcLowerCase = require("./irc/formatting").toIrcLowerCase;

function DataStore(userStore, roomStore) {
    this._roomStore = roomStore;
    this._userStore = userStore;
}



module.exports = DataStore;
