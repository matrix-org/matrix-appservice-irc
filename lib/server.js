"use strict";
var irc = require("irc");

function IrcController(ircServer) {
    this.server = ircServer;
};
IrcController.prototype.login = function() {
    this.client = new irc.Client(
        this.server.domain, this.server.nick,
        {
            channels: []
        }
    );
    var that = this;
    this.client.addListener("message", function(from, to, msg) {
        console.log("%s says %s", f, m); 
    });
    this.client.addListener("error", function(err) {
        console.error(
            "Server: %s Error: %s", that.server.domain,
            JSON.stringify(err)
        ); 
    });
};
IrcController.prototype.joinChannel = function(channel) {
    this.client.join(channel);
};
IrcController.prototype.leaveChannel = function(channel) {
    this.client.part(channel);
};
IrcController.prototype.sendText = function(channel, text) {
    this.client.say(channel, text);
};
IrcController.prototype.sendEmote = function(channel, text) {
    this.client.action(channel, text);
};
IrcController.prototype.sendNotice = function(channel, text) {
    this.client.ctcp(channel, "notice", text);
};

module.exports.IrcController = IrcController;


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

IrcServer.prototype.shouldMapAllRooms = function() {
    return this.aliasPrefix !== undefined;
};

IrcServer.prototype.isTrackingChannels = function() {
    return Object.keys(this.channelToRoomIds).length > 0;
};

module.exports.IrcServer = IrcServer;