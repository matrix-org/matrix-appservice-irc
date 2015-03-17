/*
 * Represents a single IRC server.
 */
"use strict";
var irc = require("irc");
var q = require("q");

function IrcServer(domain, opts) {
    this.domain = domain;
    this.trackedChannels = [];
    this.doNotTrackChannels = [];
    this.nick = opts && opts.nick ? opts.nick : "matrixASbot";
    if (!opts.expose) {
        opts.expose = {};
    }
    this.expose = {
        channels: Boolean(opts.expose.channels),
        privateMessages: Boolean(opts.expose.privateMessages),
    };
    this.connectionDefers = {};
    var prefix;

    if (opts && opts.rooms) {
        this.aliasPrefix = opts.rooms.aliasPrefix || (this.domain + "_");
        if (this.aliasPrefix.indexOf("#") === 0) {
            // strip leading #
            this.aliasPrefix = this.aliasPrefix.substring(1);
        }

        if (opts.rooms.mappings) {
            var channels = Object.keys(opts.rooms.mappings);
            for (var i=0; i<channels.length; i++) {
                this.trackedChannels.push(channels[i]);
            }
        }
        if (opts.rooms.exclude) {
            if (typeof opts.rooms.exclude === "string") {
                opts.rooms.exclude = [opts.rooms.exclude];
            }
            this.doNotTrackChannels = opts.rooms.exclude;
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
    return this.connectAs(this.nick, this.trackedChannels, 
                          callbacks);
};

IrcServer.prototype.connectAs = function(nick, channels, callbacks) {
    if (this.connectionDefers[nick]) {
        return this.connectionDefers[nick].promise;
    }
    this.connectionDefers[nick] = q.defer();
    var defer = this.connectionDefers[nick];
    var opts = {
        autoConnect: false
    };

    // strip do not track channels
    if (channels) {
        for (var i=0; i<channels.length; i++) {
            if (this.doNotTrackChannels.indexOf(channels[i]) !== -1) {
                channels.splice(i, 1);
                i--;
            }
        }
    }

    console.log("Connecting to IRC server %s as %s - Joining channels %s",
        this.domain, nick, channels);
    var thisServer = this;
    var client = new irc.Client(this.domain, nick, opts);
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
                if (text.indexOf("ACTION ") == 0) {
                    callbacks.onMessage(
                        thisServer, from, to, "privmsg", 
                        text.substring("ACTION ".length)
                    );
                }
            });
            client.addListener("notice", function(from, to, text) {
                if (from) { // ignore server notices
                    callbacks.onMessage(thisServer, from, to, "notice", text);
                }
            });
        }
    }

    client.connect(function() {
        if (channels) {
            for (var i=0; i<channels.length; i++) {
                client.join(channels[i]);
            }
        }
        defer.resolve(client);
    });

    return defer.promise;
};

IrcServer.prototype.shouldMapAllRooms = function() {
    return this.expose.channels;
};

IrcServer.prototype.allowsPms = function() {
    return this.expose.privateMessages;
};

IrcServer.prototype.isTrackingChannels = function() {
    return Object.keys(this.trackedChannels).length > 0;
};

module.exports.IrcServer = IrcServer;