/* 
 * A room ID specifies a Matrix room uniquely.
 * A server domain and a channel specifies an IRC room uniquely.
 * A "Room" is a combination of a unique Matrix room and a unique IRC room.
 * A Matrix room can have many Rooms (bridged to many irc channels).
 * An IRC channel can have many Rooms (bridged to many Matrix rooms).
 * Some of these bridges can be hard-coded by the launch configuration.
 * Some of these bridges are dynamically generated if:
 *  - A Matrix user invites a Virtual IRC User to a room (PM)
 *  - A Matrix user tries to join a room alias which maps to an IRC channel.
 */
"use strict";

var extend = require("extend");

var createRoom = function(protocol, opts) {
    return extend({
        protocol: protocol
    }, opts);
};

module.exports.irc = {
    createRoom: function(server, channel) {
        return createRoom("irc", {
            server: server,
            channel: channel
        });
    }
};

module.exports.matrix = {
    createRoom: function(roomId) {
        return createRoom("matrix", {
            roomId: roomId
        });
    }
};

module.exports.createBridgedRoom = function(ircRoom, matrixRoom) {
    return {
        irc: ircRoom,
        matrix: matrixRoom
    };
};