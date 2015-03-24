/*
 * Augments "User" objects with the ability to perform IRC actions.
 */
"use strict";
var q = require("q");
var log = require("../logging").get("irc-models");

function VirtualIrcUser(server, nick, userId) {
	this.server = server;
	this.nick = nick;
	this.userId = userId;
	this.joinedChannels = [];
};

VirtualIrcUser.prototype.connect = function(hooks) {
    var that = this;
    var promise = this.server.connectAs(this.nick, undefined, hooks);

    promise.done(function(client) {
        log.info("%s connected.", that.nick);
        that.client = client;
    });
    return promise;
};

VirtualIrcUser.prototype.joinChannel = function(channel) {
	if (this.joinedChannels.indexOf(channel) !== -1) {
		return q();
	}
    if (channel.indexOf("#") !== 0) {
        // PM room
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
    var msgType = msgType || "message";
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

VirtualIrcUser.prototype.setTopic = function(room, topic) {
    // join the room if we haven't already
    var defer = q.defer();
    var that = this;
    this.joinChannel(room.channel).done(function() {
        log.info("Setting topic to %s in channel %s", topic, room.channel);
        that.client.send("TOPIC", room.channel, topic);
        defer.resolve();
    });
    return defer.promise;
};
module.exports.VirtualIrcUser = VirtualIrcUser;

