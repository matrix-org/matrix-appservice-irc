/*
 * Represents a single IRC server.
 */
"use strict";

// The time we're willing to wait for a connect callback when connecting to IRC.
var CONNECT_TIMEOUT_MS = 15000; // 15s

// The delay between messages when there are >1 messages to send.
var FLOOD_PROTECTION_DELAY_MS = 700;
// The max length of <realname> in USER commands
var MAX_REAL_NAME_LENGTH = 48;
// The max length of <username> in USER commands
var MAX_USER_NAME_LENGTH = 32;
// The max amount of time we should wait for the server to ping us before reconnecting.
// Servers ping infrequently (2-3mins) so this should be high enough to allow up
// to 2 pings to lapse before reconnecting (5-6mins).
var PING_TIMEOUT_MS = 1000 * 60 * 6;

var irc = require("irc");
var q = require("q");
var ident = require("./ident");
var logging = require("../logging");
var log = logging.get("irc-server");
var actions = require("../models/actions");

/**
 * Construct a new IRC Server.
 * @constructor
 * @param {string} domain : The IRC network address
 * @param {Object} serviceConfig : The config options for this network.
 */
function IrcServer(domain, serviceConfig) {
    this.domain = domain;
    this.doNotTrackChannels = serviceConfig.dynamicChannels.exclude;
    this.nick = serviceConfig.botConfig.nick;
    this.nickPass = serviceConfig.botConfig.password;
    this.nickTemplate = serviceConfig.ircClients.nickTemplate;
    this.allowNickChanges = serviceConfig.ircClients.allowNickChanges;
    this.aliasTemplate = serviceConfig.dynamicChannels.aliasTemplate;
    this.userTemplate = serviceConfig.matrixClients.userTemplate;
    this.whitelist = serviceConfig.dynamicChannels.whitelist;
    this.enablePrivateMessages = serviceConfig.privateMessages.enabled;
    this.enableDynamicChannels = serviceConfig.dynamicChannels.enabled;
    this.publishRooms = serviceConfig.dynamicChannels.published;
    this.createAliases = serviceConfig.dynamicChannels.createAlias;
    this.joinRule = serviceConfig.dynamicChannels.joinRule;
    this.port = serviceConfig.port;
    this.maxClients = serviceConfig.ircClients.maxClients;
    this.idleTimeout = serviceConfig.ircClients.idleTimeout;
    this.ssl = Boolean(serviceConfig.ssl);
    this.mirrorJoinPart = serviceConfig.matrixClients.mirrorJoinPart;
}

var hookFunction = function(client, server, fn, isBot) {
    if (isBot) {
        client.addListener("message", function(from, to, text) {
            fn(server, from, to, actions.irc.createMessage(text));
        });
        client.addListener("ctcp-privmsg", function(from, to, text) {
            if (text.indexOf("ACTION ") === 0) {
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
            if (nick.indexOf("@") !== -1) {
                var match = nick.match(
                    // https://github.com/martynsmith/node-irc/blob/master/lib/parse_message.js#L26
                    /^([_a-zA-Z0-9\[\]\\`^{}|-]*)(!([^@]+)@(.*))?$/
                );
                if (match) {
                    nick = match[1];
                }
            }
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
            if (text.indexOf("ACTION ") === 0) {
                fn(
                    server, from, to, actions.irc.createEmote(
                        text.substring("ACTION ".length)
                    )
                );
            }
        });
    }
};

IrcServer.prototype.connect = function(channels, callbacks) {
    // auto-connect as a bot to channels being tracked.
    return this.connectAs({
        nick: this.nick,
        channels: channels
    }, callbacks);
};

/**
 * @param {Object} connectionOpts
 * @param {Object} callbacks
 * @param {Deferred=} existingDefer
 * @return {Object} A new irc.Client instance.
 */
IrcServer.prototype.connectAs = function(connectionOpts, callbacks, existingDefer) {
    var channels = connectionOpts.channels;
    var nick = connectionOpts.nick;
    var clientIsBot = nick === this.nick;
    var isDead = false;

    // strip illegal chars according to RFC 1459 Sect 2.3.1
    // but allow _ because most IRC servers allow that.
    nick = nick.replace(/[^A-Za-z0-9\]\[\^\\\{\}\-`_]/g, "");

    var username = connectionOpts.username || "matrixirc";
    // real name can be any old ASCII
    var realname = username.replace(/[^\x00-\x7F]/g, "");
    // strip out bad characters in the username (will need to do something
    // better like punycode with win95 style LONGNAM~1 in the future)
    username = username.replace(/:/g, "__");
    username = username.replace(/[^A-Za-z0-9\]\[\^\\\{\}\-`_]/g, "");

    var defer = existingDefer || q.defer();
    var opts = {
        userName: username.substring(0, MAX_USER_NAME_LENGTH),
        realName: realname.substring(0, MAX_REAL_NAME_LENGTH),
        autoConnect: false,
        autoRejoin: true,
        floodProtection: true,
        floodProtectionDelay: FLOOD_PROTECTION_DELAY_MS,
        port: this.port,
        secure: this.ssl
    };

    if (clientIsBot && this.nickPass) {
        opts.password = this.nickPass;
        log.info("Sending password for %s on %s (%s)", this.nick, this.domain,
            this.nickPass.substring(0,3)+"...");
    }

    // strip do not track channels
    if (channels) {
        for (var i = 0; i < channels.length; i++) {
            if (this.doNotTrackChannels.indexOf(channels[i]) !== -1) {
                channels.splice(i, 1);
                i--;
            }
        }
    }

    log.info("Connecting to IRC server %s as %s (user=%s)- Joining channels %s",
        this.domain, nick, username, JSON.stringify(channels));
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
    if (logging.isVerbose()) {
        client.addListener("raw", function(msg) {
            log.debug(
                "%s@%s: %s", nick, thisServer.domain, JSON.stringify(msg)
            );
        });
    }

    if (callbacks) {
        if (callbacks.onMessage) {
            hookFunction(
                client, thisServer, function() {
                    if (isDead) {
                        return;
                    }
                    callbacks.onMessage.apply(callbacks, arguments);
                }, clientIsBot
            );
        }
        // make the bot listen for join/parts
        if (callbacks.onPart && clientIsBot) {
            client.addListener("part", function(chan, nick, reason, msg) {
                callbacks.onPart(thisServer, nick, chan, "part");
            });
            client.addListener("quit", function(nick, reason, chans, msg) {
                chans = chans || [];
                chans.forEach(function(chan) {
                    callbacks.onPart(thisServer, nick, chan, "quit");
                });
            });
            client.addListener("kick", function(chan, nick, by, reason, msg) {
                callbacks.onPart(thisServer, nick, chan, "kick");
            });
        }
        if (callbacks.onJoin && clientIsBot) {
            client.addListener("join", function(chan, nick, msg) {
                callbacks.onJoin(thisServer, nick, chan, "join");
            });
            client.addListener("names", function(chan, names, msg) {
                if (names) {
                    Object.keys(names).forEach(function(nick) {
                        // var opsLevel = names[nick]; // + @ or empty string
                        // TODO do something with opsLevel
                        callbacks.onJoin(thisServer, nick, chan, "names");
                    });
                }
            });
        }
        if (callbacks.onMode && clientIsBot) {
            client.addListener("+mode", function(channel, by, mode, arg) {
                callbacks.onMode(thisServer, channel, by, mode, true, arg);
            });
            client.addListener("-mode", function(channel, by, mode, arg) {
                callbacks.onMode(thisServer, channel, by, mode, false, arg);
            });
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
                "%s (%s) still not connected after %sms. Nudging connection...",
                thisServer.domain, nick, CONNECT_TIMEOUT_MS
            );
            isDead = true;
            client.disconnect();
            thisServer.connectAs(connectionOpts, callbacks, defer);
        }
    }, CONNECT_TIMEOUT_MS);

    client.connect(function() {
        gotConnectedCallback = true;
        var localPort = -1;
        if (client.conn && client.conn.localPort) {
            localPort = client.conn.localPort;
        }
        log.info(
            "Server: %s (%s) connected (local port %s). Joining %s channels",
            thisServer.domain, nick, localPort,
            (channels ? channels.length : "0")
        );
        if (channels) {
            for (var i = 0; i < channels.length; i++) {
                client.join(channels[i]);
            }
        }
        defer.resolve(client);
    });

    client.once("connect", function() {
        var localPort = -1;
        if (client.conn && client.conn.localPort) {
            localPort = client.conn.localPort;
        }
        if (localPort > 0) {
            ident.setMapping(username, localPort);
        }
    });

    // BOTS-70 : ircd can assign random nick for bridge
    // ------------------------------------------------
    // Listen for nick changes on the bot itself and if we can't find the
    // desired string anywhere in the nick, try to change to it again.
    if (clientIsBot) {
        var nickChangeAttempts = 0; // protect against infinite nick sending
        client.addListener("nick", function(old, newNick) {
            if (nickChangeAttempts > 5) {
                log.warn(
                    "Attempted to set nick >5 times to %s from %s - Giving up.",
                    nick, newNick
                );
                return;
            }
            if (newNick && newNick.indexOf(nick) === -1) {
                log.info(
                    "Bot has been assigned nick %s but we want %s, renaming.",
                    newNick, nick
                );
                client.send("NICK", nick);
                nickChangeAttempts += 1;
            }
            else {
                nickChangeAttempts = 0;
            }
        });
    }

    // BOTS-65 : A client can get ping timed out and not reconnect.
    // ------------------------------------------------------------
    // The client is doing IRC ping/pongs, but there is no check to say
    // "hey, the server hasn't pinged me in a while, it's probably dead". The
    // RFC for pings states that pings are sent "if no other activity detected
    // from a connection." so we need to count anything we shove down the wire
    // as a ping refresh.
    var pingTimer;
    function _keepAlivePing() { // refresh the ping timer
        if (pingTimer) {
            clearTimeout(pingTimer);
        }
        pingTimer = setTimeout(function() {
            log.info(
                "Ping timeout: knifing connection for %s on %s",
                thisServer.domain, nick
            );
            // Just emit an netError which clients need to handle anyway.
            client.emit("netError", {
                msg: "Client-side ping timeout"
            });
        }, PING_TIMEOUT_MS);
    }
    client.on("ping", function(svr) {
        log.debug("Received ping from %s directed at %s", svr, nick);
        _keepAlivePing();
    });
    // decorate client.send to refresh the timer
    var realSend = client.send;
    client.send = function(command) {
        _keepAlivePing();
        realSend.apply(client, arguments);
    };

    return defer.promise;
};

IrcServer.prototype.hasInviteRooms = function() {
    return (
        this.enableDynamicChannels && this.joinRule === "invite"
    );
};

// check if this server dynamically create rooms with aliases.
IrcServer.prototype.createsDynamicAliases = function() {
    return (
        this.enableDynamicChannels && this.createAliases
    );
};

// check if this server dynamically creates rooms which are joinable via an alias only.
IrcServer.prototype.createsPublicAliases = function() {
    return (
        this.enableDynamicChannels && this.createAliases && this.joinRule === "public"
    );
};

IrcServer.prototype.allowsPms = function() {
    return this.enablePrivateMessages;
};

IrcServer.prototype.shouldMirrorJoinParts = function() {
    return this.mirrorJoinPart;
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
};

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
}

function escapeRegExp(string) {
    // https://developer.mozilla.org/en/docs/Web/JavaScript/Guide/Regular_Expressions
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports.IrcServer = IrcServer;
