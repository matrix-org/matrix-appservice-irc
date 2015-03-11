"use strict";
var matrixSdk = require("matrix-js-sdk");
matrixSdk.usePromises();
var models = require("../models");
var MatrixUser = models.MatrixUser;
var MatrixRoom = models.MatrixRoom;
var globalClient = undefined;

module.exports.sendMessage = function(room, from, msgtype, text) {
	msgtype = msgtype || "m.text";
	globalClient.userId = from.userId;
	globalClient.sendMessage(
		room.roomId, {
			msgtype: msgtype,
			body: text
		}
	).then(function(suc) {
		console.log("sendMessage: %s", JSON.stringify(suc));
	},
	function(err) {
		console.error("sendMessage: %s", JSON.stringify(err));
	});
};

module.exports.getMatrixUser = function(userId) {
	// TODO create user if they don't exist.
	return new MatrixUser(userId);
};

module.exports.getMatrixRoom = function(roomId) {
	// NB: This function doesn't create rooms because we don't lazily
	// create *matrix* rooms when IRC people speak, only when it is
	// matrix initiated.

	// TODO pull room data from database if exists.
	return new MatrixRoom(roomId);
};

module.exports.setMatrixClientConfig = function(config) {
    globalClient = matrixSdk.createClient(config);
};