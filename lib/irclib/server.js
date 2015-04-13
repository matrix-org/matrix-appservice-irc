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
    this.nickTemplate = serviceConfig.ircClients.nickTemplate;
    this.aliasTemplate = serviceConfig.dynamicChannels.aliasTemplate;
    this.userTemplate = serviceConfig.matrixClients.userTemplate;
    this.expose = {
        channels: serviceConfig.dynamicChannels.enabled,
        privateMessages: serviceConfig.privateMessages.enabled
    };
    this.port = serviceConfig.port;
    this.maxClients = serviceConfig.ircClients.maxClients;
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

IrcServer.prototype.getUserLocalpart = function(nick) {
    // the template is just a literal string with special vars; so find/replace
    // the vars and strip the @
    var uid = this.userTemplate.replace(/\$SERVER/g, this.domain);
    return uid.replace(/\$NICK/g, nick).substring(1);
};

IrcServer.prototype.claimsUserId = function(userId) {
    // the server claims the given user ID if the ID matches the user ID template.
    var regex = templateToRegex(
        this.userTemplate,
        {
            "$SERVER": this.domain
        },
        {
            "$NICK": "(.*)"
        },
        ":.*"
    );
    return new RegExp(regex).test(userId);
};

IrcServer.prototype.getNickFromUserId = function(userId) {
    // extract the nick from the given user ID
    var regex = templateToRegex(
        this.userTemplate,
        {
            "$SERVER": this.domain
        },
        {
            "$NICK": "(.*)"
        },
        ":.*"
    );
    var match = new RegExp(regex).exec(userId);
    if (!match) {
        return null;
    }
    return match[1];
};

IrcServer.prototype.claimsAlias = function(alias) {
    // the server claims the given alias if the alias matches the alias template
    var regex = templateToRegex(
        this.aliasTemplate,
        {
            "$SERVER": this.domain
        },
        {
            "$CHANNEL": "(.*)"
        },
        ":.*"
    );
    return new RegExp(regex).test(alias);
};

IrcServer.prototype.getChannelFromAlias = function(alias) {
    // extract the channel from the given alias
    var regex = templateToRegex(
        this.aliasTemplate,
        {
            "$SERVER": this.domain
        },
        {
            "$CHANNEL": "(.*)"
        },
        ":.*"
    );
    var match = new RegExp(regex).exec(alias);
    if (!match) {
        return null;
    }
    return match[1];
}

IrcServer.prototype.getNick = function(userId, displayName) {
    var localpart = userId.substring(1).split(":")[0];
    var display = displayName || localpart;
    var template = this.nickTemplate;
    var nick = template.replace(/\$USERID/g, userId);
    nick = nick.replace(/\$LOCALPART/g, localpart);
    nick = nick.replace(/\$DISPLAY/g, display);
    return nick;
};

IrcServer.prototype.getAliasRegex = function() {
    return templateToRegex(
        this.aliasTemplate,
        {
            "$SERVER": this.domain  // find/replace $server
        },
        {
            "$CHANNEL": ".*"  // the nick is unknown, so replace with a wildcard
        },
        // The regex applies to the entire alias, so add a wildcard after : to
        // match all domains.
        ":.*"
    );
};

IrcServer.prototype.getUserRegex = function() {
    return templateToRegex(
        this.userTemplate,
        {
            "$SERVER": this.domain  // find/replace $server
        },
        {
            "$NICK": ".*"  // the nick is unknown, so replace with a wildcard
        },
        // The regex applies to the entire user ID, so add a wildcard after : to
        // match all domains.
        ":.*"
    );
};

function templateToRegex(template, literalVars, regexVars, suffix) {
    // The 'template' is a literal string with some special variables which need
    // to be find/replaced.
    var regex = template;
    Object.keys(literalVars).forEach(function(varPlaceholder) {
        regex = regex.replace(
            new RegExp(escapeRegExp(varPlaceholder), 'g'),
            literalVars[varPlaceholder]
        );
    });

    // at this point the template is still a literal string, so escape it before
    // applying the regex vars.
    regex = escapeRegExp(regex);
    // apply regex vars
    Object.keys(regexVars).forEach(function(varPlaceholder) {
        regex = regex.replace(
            // double escape, because we bluntly escaped the entire string before
            // so our match is now escaped.
            new RegExp(escapeRegExp(escapeRegExp(varPlaceholder)), 'g'),
            regexVars[varPlaceholder]
        );
    });

    suffix = suffix || "";
    return regex + suffix;
};

function escapeRegExp(string) {
    // MDN -> https://developer.mozilla.org/en/docs/Web/JavaScript/Guide/Regular_Expressions
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

module.exports.IrcServer = IrcServer;