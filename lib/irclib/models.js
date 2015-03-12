"use strict";
var q = require("q");

function IrcRoom(server, channel) {
    this.server = server;
    this.channel = channel;
};
module.exports.IrcRoom = IrcRoom;

function VirtualIrcUser(server, nick, userId) {
	this.server = server;
	this.nick = nick;
	this.userId = userId;
	this.joinedChannels = [];
};

VirtualIrcUser.prototype.connect = function() {
    var that = this;
    var promise = this.server.connectAs(this.nick);

    promise.done(function(client) {
        console.log("%s connected.", that.nick);
        that.client = client;
    });
    return promise;
};

VirtualIrcUser.prototype.joinChannel = function(channel) {
	if (this.joinedChannels.indexOf(channel) !== -1) {
		return q();
	}

	var defer = q.defer();
	var that = this;
	this.client.join(channel, function() {
		that.joinedChannels.push(channel);
		defer.resolve();
	});

	return defer.promise;
};

VirtualIrcUser.prototype.sendMessage = function(room, msgType, text) {
    // join the room if we haven't already
    var defer = q.defer();
    var that = this;
    this.joinChannel(room.channel).done(function() {
    	if (msgType == "privmsg") {
            that.client.action(room.channel, text);
        }
        else if (msgType == "notice") {
            that.client.ctcp(room.channel, "notice", text);
        }
        else if (msgType == "message") {
            that.client.say(room.channel, text);
        }
        defer.resolve();
    });
    return defer.promise;
};
module.exports.VirtualIrcUser = VirtualIrcUser;

