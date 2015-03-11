"use strict";
var irc = require("irc");

function IrcServer(domain, opts) {
    this.domain = domain;
    this.nick = opts && opts.nick ? opts.nick : "matrixASbot";
    this.channelToRoomIds = {};
    var prefix;

    if (opts && opts.rooms) {
        var channels = Object.keys(opts.rooms);
        for (var i=0; i<channels.length; i++) {
            var channel = channels[i];
            if (channel === "*" && typeof opts.rooms["*"] === "string") {
                prefix = opts.rooms["*"];
                // strip leading #
                if (prefix.indexOf("#") === 0) {
                    prefix = prefix.substring(1);
                }
                this.aliasPrefix = prefix;
                continue;
            }

            if (typeof opts.rooms[channel] === "string") {
                opts.rooms[channel] = [opts.rooms[channel]]
            }

            this.channelToRoomIds[channel] = opts.rooms[channel];
        }
    }

    if (opts && typeof opts.virtualUserPrefix === "string") {
        prefix = opts.virtualUserPrefix;
        if (prefix.indexOf("@") === 0) {
            prefix = prefix.substring(1);
        }
        this.userPrefix = prefix;
    }
    else {
        // user prefix is just going to be the IRC domain with an _
        // e.g. @irc.freenode.net_Alice:homserver.com
        this.userPrefix = this.domain + "_";
    }
};

IrcServer.prototype.connect = function(callbacks) {
    // auto-connect as a bot to channels being tracked.
    return this.connectAs(this.nick, Object.keys(this.channelToRoomIds), 
                          callbacks);
};

IrcServer.prototype.connectAs = function(nick, channels, callbacks) {
    console.log("Connecting to IRC server %s as %s - Joining channels %s",
        this.domain, nick, channels);
    var thisServer = this;
    var client = new irc.Client(
        this.domain, nick,
        {
            channels: channels
        }
    );
    client.addListener("error", function(err) {
        console.error(
            "Server: %s Error: %s", thisServer.domain,
            JSON.stringify(err)
        ); 
    });
    
    if (callbacks) {
        if (callbacks.onMessage) {
            client.addListener("message", function(from, to, text) {
                callbacks.onMessage(thisServer, from, to, "message", text);
            });
            client.addListener("ctcp-privmsg", function(from, to, text) {
                callbacks.onMessage(thisServer, from, to, "privmsg", text);
            });
            client.addListener("notice", function(from, to, text) {
                if (from) { // ignore server notices
                    callbacks.onMessage(thisServer, from, to, "notice", text);
                }
            });
        }
    }
    return client;
};

IrcServer.prototype.shouldMapAllRooms = function() {
    return this.aliasPrefix !== undefined;
};

IrcServer.prototype.isTrackingChannels = function() {
    return Object.keys(this.channelToRoomIds).length > 0;
};

module.exports.IrcServer = IrcServer;