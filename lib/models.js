"use strict";
/*
var irc = require("irc");

function IrcController(ircServer) {
    this.server = ircServer;
};
IrcController.prototype.login = function() {
    this.client = new irc.Client(
        this.server.domain, this.server.nick,
        {
            channels: []
        }
    );
    var that = this;
    this.client.addListener("message", function(from, to, msg) {
        console.log("%s says %s", f, m); 
    });
    this.client.addListener("error", function(err) {
        console.error(
            "Server: %s Error: %s", that.server.domain,
            JSON.stringify(err)
        ); 
    });
};
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

function MatrixUser(userId) {
    this.userId = userId;
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
