"use strict";

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
