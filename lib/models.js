"use strict";

function MatrixRoom(roomId) {
    this.roomId = roomId;
};
module.exports.MatrixRoom = MatrixRoom;

function MatrixUser(userId) {
    this.userId = userId;
};
module.exports.MatrixUser = MatrixUser;

/*
IrcController.prototype.joinChannel = function(channel) {
    this.client.join(channel);
};
IrcController.prototype.leaveChannel = function(channel) {
    this.client.part(channel);
};
IrcController.prototype.sendText = function(channel, text) {
    this.client.say(channel, text);
};
IrcController.prototype.sendEmote = function(channel, text) {
    this.client.action(channel, text);
};
IrcController.prototype.sendNotice = function(channel, text) {
    this.client.ctcp(channel, "notice", text);
};

module.exports.IrcController = IrcController;
*/


// Users
function User() {

};

function IrcUser(server, ircNick) {
    this.server = server;
    this.nick = ircNick;
};

function VirtualUser(ircUser, matrixUser) {
    this.matrix = matrixUser;
    this.irc = ircUser;
};

// Rooms

function Room(roomId, ircServer, ircChannel) {
    this.roomId = roomId;
    this.ircServer = ircServer;
    this.ircChannel = ircChannel;
};

function PmRoom(room, virtualUser, matrixUser) {
    this.room = room;
    this.virtualUser = virtualUser;
    this.matrixUser = matrixUser;
};
