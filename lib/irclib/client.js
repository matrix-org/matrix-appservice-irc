/*
 * Augments "User" objects with the ability to perform IRC actions.
 */
"use strict";
var q = require("q");
var pool = require("./server-pool");
var log = require("../logging").get("irc-models");

function VirtualIrcUser(ircUser, userId) {
    this.server = ircUser.server;
    this.nick = ircUser.nick;
    this.userId = userId;
    this.lastActionTs = Date.now();
}

VirtualIrcUser.prototype.connect = function(hooks) {
    var that = this;
    var promise = this.server.connectAs(this.nick, undefined, hooks);

    promise.done(function(client) {
        // we may have been assigned a different nick, so update it from source
        that.nick = client.nick;
        that.client = client;
        that._keepAlive();
        client.addListener("netError", function(err) {
            // reconnect after 10s
            log.info("Reconnecting %s in 10 seconds...", that.nick);
            that.client.disconnect();
            setTimeout(function() {
                that.connect(hooks).done(function(newClient) {
                    console.log("%s reconnected.", newClient.nick);
                });
            }, 10000);
        });
    });
    return promise;
};

VirtualIrcUser.prototype.disconnect = function(reason) {
    if (!this.client) {
        return q();
    }
    var d = q.defer();
    this.client.disconnect(reason, function() {
        d.resolve();
    });
    return d.promise;
};

VirtualIrcUser.prototype.changeNick = function(newNick) {
    var that = this;
    // strip illegal chars according to RFC 1459 Sect 2.3.1
    // but allow _ because most IRC servers allow that.
    var nick = newNick.replace(/[^A-Za-z0-9\]\[\^\\\{\}\-`_]/g, "");
    // nicks must start with a letter
    if (!/^[A-Za-z]/.test(nick)) {
        return q.reject("Nick '"+nick+"' must start with a letter.");
    }
    var maxNickLen = 9; // RFC 1459 default
    if (this.client.supported && typeof this.client.supported.nicklength == "number") {
        maxNickLen = this.client.supported.nicklength;
    }
    if (nick.length > maxNickLen) {
        return q.reject("Nick '"+nick+"' is too long. (Max: "+maxNickLen+")");
    }
    if (nick === this.nick) {
        return q("Your nick is already '"+nick+"'.");
    }

    var d = q.defer();
    this.client.once("nick", function(old, n) {
        d.resolve("Nick changed from '"+old+"' to '"+n+"'.");
        that.nick = n;
        pool.updateIrcNick(that, old, n);
    });
    this.client.send("NICK", nick);
    return d.promise;
};

VirtualIrcUser.prototype.sendAction = function(room, action) {
    this._keepAlive();
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
VirtualIrcUser.prototype._keepAlive = function() {
    this.lastActionTs = Date.now();
};
VirtualIrcUser.prototype.getLastActionTs = function() {
    return this.lastActionTs;
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
    msgType = msgType || "message";
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
    if (Object.keys(that.client.chans).indexOf(channel) !== -1) {
        return q();
    }
    if (channel.indexOf("#") !== 0) {
        // PM room
        return q();
    }

    var defer = q.defer();
    log.debug("[%s,%s,%s] Joining channel %s", 
        that.userId, that.server.domain, that.nick, channel
    );
    that.client.join(channel, function() {
        log.debug("[%s,%s,%s] Joined channel %s", 
            that.userId, that.server.domain, that.nick, channel
        );
        defer.resolve();
    });

    return defer.promise;
};