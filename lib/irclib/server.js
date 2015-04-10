/*
 * Represents a single IRC server.
 */
"use strict";
var irc = require("irc");
var q = require("q");
var log = require("../logging").get("irc-server");
var actions = require("../models/actions");

var hookFunction = function(client, server, fn, isBot) {
    if (isBot) {
        client.addListener("message", function(from, to, text) {
            fn(server, from, to, actions.irc.createMessage(text));
        });
        client.addListener("ctcp-privmsg", function(from, to, text) {
            if (text.indexOf("ACTION ") == 0) {
                fn(server, from, to, actions.irc.createEmote(
                    text.substring("ACTION ".length)
                ));
            }
        });
        client.addListener("notice", function(from, to, text) {
            if (from) { // ignore server notices
                fn(server, from, to, actions.irc.createNotice(text));
            }
        });
        client.addListener("topic", function(channel, topic, nick) {
            fn(server, nick, channel, actions.irc.createTopic(topic));
        });
    }
    else {
        // just listen for PMs for clients. If you listen for rooms, you'll get
        // duplicates since the bot will also invoke the callback fn!
        client.addListener("message", function(from, to, text) {
            if (to.indexOf("#") === 0) { return; }
            fn(server, from, to, actions.irc.createMessage(text));
        });
        client.addListener("notice", function(from, to, text) {
            if (!from || to.indexOf("#") === 0) { return; }
            fn(server, from, to, actions.irc.createNotice(text));
        });
        client.addListener("ctcp-privmsg", function(from, to, text) {
            if (to.indexOf("#") === 0) { return; }
            if (text.indexOf("ACTION ") == 0) {
                fn(
                    server, from, to, actions.irc.createEmote(
                        text.substring("ACTION ".length)
                    )
                );
            }
        });
    }
};

function IrcServer(domain, serviceConfig) {
    this.domain = domain;
    this.doNotTrackChannels = serviceConfig.dynamicChannels.exclude;
    this.nick = serviceConfig.botConfig.nick;
    this.nickPrefix = serviceConfig.matrixClients.userTemplate;
    this.aliasPrefix = serviceConfig.dynamicChannels.aliasTemplate;
    this.userPrefix = serviceConfig.matrixClients.userTemplate;
    this.expose = {
        channels: serviceConfig.dynamicChannels.enabled,
        privateMessages: serviceConfig.privateMessages.enabled
    };
    this.port = serviceConfig.port;
    this.ssl = Boolean(serviceConfig.ssl);
    this.connectionDefers = {};
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
        floodProtectionDelay: 500,
        port: this.port,
        secure: this.ssl
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
        this.domain, nick, JSON.stringify(channels));
    var thisServer = this;
    var client = new irc.Client(this.domain, nick, opts);
    client.addListener("error", function(err) {
        log.error(
            "Server: %s (%s) Error: %s", thisServer.domain, nick,
            JSON.stringify(err)
        ); 
    });
    client.addListener("netError", function(err) {
        log.error(
            "Server: %s (%s) Network Error: %s", thisServer.domain, nick,
            // take up more lines to be more visible ^_________^
            JSON.stringify(err, undefined, 2)
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
        log.info("Server: %s (%s) connected.", thisServer.domain, nick);
        if (channels) {
            for (var i=0; i<channels.length; i++) {
                client.join(channels[i]);
            }
        }
        defer.resolve(client);
    });

    return defer.promise;
};

IrcServer.prototype.allowsPms = function() {
    return this.expose.privateMessages;
};

module.exports.IrcServer = IrcServer;