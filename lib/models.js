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

// TODO:
// Would using MongoDB make this basically trivial to write? You just create or
// delete a unique 3-uple (room id, irc domain, irc channel), and can absolutely
// trivially pull out all the matching ones for a room ID, etc. We need to have
// some way of persisting this anyway (due to the dynamic bridges), so this 
// seems like the obvious choice.

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



function RoomStore() {
    this.ircToMatrix = {
        // server.domain: {
        //    channel: [Room, Room, Room]
        // }
    };
    this.matrixToIrc = {
        // room_id: [Room, Room, Room]
    };
};
RoomStore.prototype.storeRoom = function(room) {
    if (room.roomId) {
        if (!this.matrixToIrc[room.roomId]) {
            this.matrixToIrc[room.roomId] = [];
        }
        var exists = false;
        for (var i=0; i<this.matrixToIrc[room.roomId].length; i++) {
            if (this.matrixToIrc[room.roomId][i] === room) {
                // already stored, but don't return since we
                // need to check for irc mappings.
                exists = true;
                break;
            }
        }
        if (!exists) {
            this.matrixToIrc[room.roomId].push(room);
        }
    }
    if (room.server && room.channel) {
        if (!this.ircToMatrix[room.server.domain]) {
            this.ircToMatrix[room.server.domain] = {};
        }
        if (!this.ircToMatrix[room.server.domain][room.channel]) {
            this.ircToMatrix[room.server.domain][room.channel] = [];
        }
        var roomList = this.ircToMatrix[room.server.domain][room.channel];
        for (var i=0; i<roomList.length; i++) {
            if (roomList[i] === room) {
                return;
            }
        }
        roomList.push(room);
    }
};
RoomStore.prototype.getRoomsForRoomId = function(roomId) {
    return this.matrixToIrc[roomId] || [];
};
RoomStore.prototype.getRoomsForChannel = function(server, channel) {
    if (!this.ircToMatrix[server.domain]) {
        return [];
    }
    return this.ircToMatrix[server.domain][channel] || [];
};
RoomStore.prototype.setRoomsFromConfig = function(server, opts) {
    if (opts && opts.rooms) {
        var channels = Object.keys(opts.rooms);
        for (var i=0; i<channels.length; i++) {
            var channel = channels[i];
            if (channel === "*") {
                continue;
            }

            if (typeof opts.rooms[channel] === "string") {
                opts.rooms[channel] = [opts.rooms[channel]]
            }
            for (var k=0; k<opts.rooms[channel].length; k++) {
                var room = new Room();
                room.server = server;
                room.channel = channel;
                room.roomId = opts.rooms[channel][k];
                console.log("Storing room: %s on %s => %s",
                    channel, server.domain, room.roomId);
                this.storeRoom(room);
            }
        }
    }
};
module.exports.RoomStore = RoomStore;