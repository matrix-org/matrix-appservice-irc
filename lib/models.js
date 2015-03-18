/* 
 * Contains 'common' models between IRC and Matrix.
 *
 * Rooms
 * =====
 * A room ID specifies a Matrix room uniquely.
 * A server domain and a channel specifies an IRC room uniquely.
 * A "Room" is a combination of a unique Matrix room and a unique IRC room.
 * A Matrix room can have many Rooms (bridged to many irc channels).
 * An IRC channel can have many Rooms (bridged to many Matrix rooms).
 * Some of these bridges can be hard-coded by the launch configuration.
 * Some of these bridges are dynamically generated if:
 *  - A Matrix user invites a Virtual IRC User to a room (PM)
 *  - A Matrix user tries to join a room alias which maps to an IRC channel.
 *
 * Users
 * =====
 * A user ID represents a Matrix user uniquely.
 * An IRC nick and server domain represent an IRC user uniquely.
 * Some user IDs are special and should NOT be relayed (with the AS user prefix)
 * Some IRC nicks are special and should NOT be relayed (stored IRC mapping)
 * A "User" is a combination of a user ID and a domain/nick combo. It may be
 * missing fields if it should NOT be relayed.
 *
 * This file contains the models necessary for representing all of this.
 */
"use strict";

function Room() {
    this.roomId = undefined;
    this.server = undefined;
    this.channel = undefined;
};
module.exports.Room = Room;
module.exports.createIrcRoom = function(server, channel) {
    var room = new Room();
    room.server = server;
    room.channel = channel;
    return room;
};
module.exports.createMatrixRoom = function(roomId) {
    var room = new Room();
    room.roomId = roomId;
    return room;
};

function User() {
    this.server = undefined;
    this.nick = undefined;
    this.userId = undefined;
};
module.exports.User = User;
module.exports.createMatrixUser = function(userId) {
    var user = new User();
    user.userId = userId;
    return user;
};