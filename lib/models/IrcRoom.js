"use strict";
const RemoteRoom = require("matrix-appservice-bridge").RemoteRoom;
const toIrcLowerCase = require("../irc/formatting").toIrcLowerCase;

class IrcRoom extends RemoteRoom {
    /**
     * Construct a new IRC room.
     * @constructor
     * @param {IrcServer} server : The IRC server which contains this room.
     * @param {String} channel : The channel this room represents.
     */
    constructor(server, channel) {
        if (!server || !channel) {
            throw new Error("Server and channel are required.");
        }
        channel = toIrcLowerCase(channel);
        super(IrcRoom.createId(server, channel), {
            domain: server.domain,
            channel: channel,
            type: channel.indexOf("#") === 0 ? "channel" : "pm"
        });
        this.server = server;
        this.channel = channel;
    }

    getDomain() {
        return this.get("domain");
    }

    getServer() {
        return this.server;
    }

    getChannel() {
        return this.get("channel");
    }

    getType() {
        return this.get("type");
    }
}

IrcRoom.fromRemoteRoom = function(server, remoteRoom) {
    return new IrcRoom(server, remoteRoom.get("channel"));
};

// An IRC room is uniquely identified by a combination of the channel name and the
// IRC network the channel resides on. Space is the delimiter because neither the
// domain nor the channel allows spaces.
IrcRoom.createId = function(server, channel) {
    return server.domain + " " + channel;
};

module.exports = IrcRoom;
