/*
 * Represents a single IRC server.
 */
"use strict";
var irc = require("irc");
var q = require("q");
var log = require("../logging").get("irc-server");


var hookFunction = function(client, server, fn, isBot) {
    if (isBot) {
        client.addListener("message", function(from, to, text) {
            fn(server, from, to, "message", text);
        });
        client.addListener("ctcp-privmsg", function(from, to, text) {
            if (text.indexOf("ACTION ") == 0) {
                fn(
                    server, from, to, "privmsg", 
                    text.substring("ACTION ".length)
                );
            }
        });
        client.addListener("notice", function(from, to, text) {
            if (from) { // ignore server notices
                fn(server, from, to, "notice", text);
            }
        });
        client.addListener("topic", function(channel, topic, nick) {
            fn(server, nick, channel, "topic", topic);
        });
    }
    else {
        // just listen for PMs for clients. If you listen for rooms, you'll get
        // duplicates since the bot will also invoke the callback fn!
        client.addListener("message", function(from, to, text) {
            if (to.indexOf("#") === 0) { return; }
            fn(server, from, to, "message", text);
        });
        client.addListener("ctcp-privmsg", function(from, to, text) {
            if (to.indexOf("#") === 0) { return; }
            if (text.indexOf("ACTION ") == 0) {
                fn(
                    server, from, to, "privmsg", 
                    text.substring("ACTION ".length)
                );
            }
        });
    }
};

function IrcServer(domain, opts) {
    this.domain = domain;
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
        if (opts.rooms.exclude) {
            if (typeof opts.rooms.exclude === "string") {
                opts.rooms.exclude = [opts.rooms.exclude];
            }
            this.doNotTrackChannels = opts.rooms.exclude;
        }
    }

    if (opts && typeof opts.userPrefix === "string") {
        prefix = opts.userPrefix;
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

IrcServer.prototype.connect = function(channels, callbacks) {
    // auto-connect as a bot to channels being tracked.
    return this.connectAs(this.nick, channels, 
                          callbacks);
};

IrcServer.prototype.connectAs = function(nick, channels, callbacks) {
    if (this.connectionDefers[nick]) {
        return this.connectionDefers[nick].promise;
    }
    this.connectionDefers[nick] = q.defer();
    var defer = this.connectionDefers[nick];
    var opts = {
        autoConnect: false,
        autoRejoin: true,
        floodProtection: true,
        floodProtectionDelay: 500
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

    log.info("Connecting to IRC server %s as %s - Joining channels %s",
        this.domain, nick, channels);
    var thisServer = this;
    var client = new irc.Client(this.domain, nick, opts);
    client.addListener("error", function(err) {
        log.error(
            "Server: %s Error: %s", thisServer.domain,
            JSON.stringify(err)
        ); 
    });

    if (callbacks) {
        if (callbacks.onMessage) {
            hookFunction(
                client, thisServer, callbacks.onMessage, nick === this.nick
            );
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

module.exports.IrcServer = IrcServer;