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
    this.allowNickChanges = serviceConfig.ircClients.allowNickChanges;
    this.aliasTemplate = serviceConfig.dynamicChannels.aliasTemplate;
    this.userTemplate = serviceConfig.matrixClients.userTemplate;
    this.whitelist = serviceConfig.dynamicChannels.whitelist;
    this.enablePrivateMessages = serviceConfig.privateMessages.enabled;
    this.enableDynamicChannels = serviceConfig.dynamicChannels.enabled;
    this.dynamicChannelVisibility = serviceConfig.dynamicChannels.visibility;
    this.port = serviceConfig.port;
    this.maxClients = serviceConfig.ircClients.maxClients;
    this.ssl = Boolean(serviceConfig.ssl);
};

IrcServer.prototype.connect = function(channels, callbacks) {
    // auto-connect as a bot to channels being tracked.
    return this.connectAs(this.nick, channels, 
                          callbacks);
};

IrcServer.prototype.connectAs = function(nick, channels, callbacks, existingDefer) {
    var defer = existingDefer || q.defer();
    var opts = {
        autoConnect: false,
        autoRejoin: true,
        floodProtection: true,
        floodProtectionDelay: 700,
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

    // Start a 10s timer to redo the connection if we haven't connected. This
    // has been added because in the wild it is possible to just never get
    // a connected callback, or a netError/error callback from the IRC lib :(
    // e.g. just the "Connecting to" line and that's it.
    var gotConnectedCallback = false;
    setTimeout(function() {
        if (!gotConnectedCallback) {
            log.error(
                "%s (%s) still not connected after 15s. Nudging connection...",
                thisServer.domain, nick
            );
            client.disconnect();
            thisServer.connectAs(nick, channels, callbacks, defer);
        }
    }, 15000);

    client.connect(function() {
        gotConnectedCallback = true;
        log.info("Server: %s (%s) connected. Joining %s channels", 
            thisServer.domain, nick, (channels ? channels.length : "0"));
        if (channels) {
            for (var i=0; i<channels.length; i++) {
                client.join(channels[i]);
            }
        }
        defer.resolve(client);
    });

    return defer.promise;
};

IrcServer.prototype.exposesChannelsPublicly = function() {
    return (
        this.enableDynamicChannels && this.dynamicChannelVisibility == "public"
    );
};

IrcServer.prototype.allowsPms = function() {
    return this.enablePrivateMessages;
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