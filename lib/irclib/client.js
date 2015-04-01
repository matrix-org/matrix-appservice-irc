/*
 * Augments "User" objects with the ability to perform IRC actions.
 */
"use strict";
var q = require("q");
var log = require("../logging").get("irc-models");

function VirtualIrcUser(ircUser, userId) {
	this.server = ircUser.server;
	this.nick = ircUser.nick;
	this.userId = userId;
	this.joinedChannels = [];
};

VirtualIrcUser.prototype.connect = function(hooks) {
    var that = this;
    var promise = this.server.connectAs(this.nick, undefined, hooks);

    promise.done(function(client) {
        that.client = client;
    });
    return promise;
};

VirtualIrcUser.prototype.sendAction = function(room, action) {
    switch (action.action) {
        case "message":
            return sendMessage(this, room, "message", action.text);
        case "notice":
            return sendMessage(this, room, "notice", action.text);
        case "emote":
            return sendMessage(this, room, "action", action.text);
        case "topic":
            return setTopic(this, room, action.topic);
        default:
            log.error("Unknown action type: %s", action.action);
    }
    return q.reject("Unknown action type: %s", action.action);
};
module.exports.VirtualIrcUser = VirtualIrcUser;


var setTopic = function(that, room, topic) {
    // join the room if we haven't already
    var defer = q.defer();
    joinChannel(that, room.channel).done(function() {
        log.info("Setting topic to %s in channel %s", topic, room.channel);
        that.client.send("TOPIC", room.channel, topic);
        defer.resolve();
    });
    return defer.promise;
};

var sendMessage = function(that, room, msgType, text) {
    // join the room if we haven't already
    var defer = q.defer();
    var msgType = msgType || "message";
    joinChannel(that, room.channel).done(function() {
        if (msgType == "action") {
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

var joinChannel = function(that, channel) {
    if (that.joinedChannels.indexOf(channel) !== -1) {
        return q();
    }
    if (channel.indexOf("#") !== 0) {
        // PM room
        return q();
    }

    var defer = q.defer();
    that.client.join(channel, function() {
        that.joinedChannels.push(channel);
        defer.resolve();
    });

    return defer.promise;
};