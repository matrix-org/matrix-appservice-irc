/*
 * Represents a single IRC server.
 */
"use strict";

// The max length of <realname> in USER commands
var MAX_REAL_NAME_LENGTH = 48;
// The max length of <username> in USER commands
var MAX_USER_NAME_LENGTH = 32;

var q = require("q");
var ident = require("./ident");
var clientConnection = require("./client-connection");
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
    this.mirrorMatrixJoinParts = serviceConfig.ircClients.mirrorJoinPart;
    this.mirrorIrcJoinParts = serviceConfig.matrixClients.mirrorJoinPart;
    this.membershipLists = serviceConfig.membershipLists;

    if (this.membershipLists.enabled) {
        // Clobber mirrorJoinPart rules for the servers we're syncing, as we inject
        // into the bridge as if they were joining/leaving in realtime.
        log.info(
            "Syncing member lists is enabled for %s. Forcing mirrorJoinPart " +
            "rules to be ON.", this.domain
        );
        if (!this.mirrorMatrixJoinParts) {
            log.info("Forcing ircClients.mirrorJoinPart to TRUE.");
            this.mirrorMatrixJoinParts = true;
        }
        if (!this.mirrorIrcJoinParts) {
            log.info("Forcing matrixClients.mirrorJoinPart to TRUE.");
            this.mirrorIrcJoinParts = true;
        }
    }
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
    username = username.substring(0, MAX_USER_NAME_LENGTH);
    realname = realname.substring(0, MAX_REAL_NAME_LENGTH);
    var password = clientIsBot ? this.nickPass : undefined;

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
    var defer = q.defer();
    clientConnection.create(this, {
        nick: nick,
        username: username,
        realname: realname,
        password: password
    }, function(ircasClient) {
        var client = ircasClient.client;
        // created callbacks
        if (clientIsBot) {
            // make the bot listen for join/parts
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
            client.addListener("join", function(chan, nick, msg) {
                callbacks.onJoin(thisServer, nick, chan, "join");
            });
            // bucket names and drain them once per second to avoid flooding
            // the matrix side with registrations / joins
            var namesBucket = [
            //  { chan: <channel>, nick: <nick> }
            ];
            var processingBucket = false;
            var popName = function() {
                var name = namesBucket.pop(); // LIFO but who cares
                if (!name) {
                    processingBucket = false;
                    return;
                }
                log.debug(
                    "Pop %s/%s from names bucket (%s remaining)",
                    name.nick, name.chan, namesBucket.length
                );
                callbacks.onJoin(thisServer, name.nick, name.chan, "names");
                setTimeout(popName, 1000);
            };

            client.addListener("names", function(chan, names, msg) {
                if (names) {
                    Object.keys(names).forEach(function(nick) {
                        namesBucket.push({
                            chan: chan,
                            nick: nick
                        });
                        // var opsLevel = names[nick]; // + @ or empty string
                        // TODO do something with opsLevel
                    });
                    log.debug("Names bucket has %s entries", namesBucket.length);
                    if (!processingBucket) {
                        processingBucket = true;
                        popName();
                    }
                }
            });
            // listen for mode changes
            client.addListener("+mode", function(channel, by, mode, arg) {
                callbacks.onMode(thisServer, channel, by, mode, true, arg);
            });
            client.addListener("-mode", function(channel, by, mode, arg) {
                callbacks.onMode(thisServer, channel, by, mode, false, arg);
            });
        }
        // listen for messages on both bot/clients (different chans for PMs)
        hookFunction(client, thisServer, function() {
            if (ircasClient.dead) {
                return;
            }
            callbacks.onMessage.apply(callbacks, arguments);
        }, clientIsBot);
    }).done(function(ircasClient) {
        var localPort = -1;
        if (ircasClient.client.conn && ircasClient.client.conn.localPort) {
            localPort = ircasClient.client.conn.localPort;
        }
        if (localPort > 0) {
            ident.setMapping(username, localPort);
        }
        // join specified channels
        if (channels) {
            for (var i = 0; i < channels.length; i++) {
                ircasClient.client.join(channels[i]);
            }
        }
        defer.resolve(ircasClient.client);
    }, function(e) {
        defer.reject(e);
    });

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

IrcServer.prototype.shouldMirrorMatrixJoinParts = function() {
    return this.mirrorMatrixJoinParts;
};

IrcServer.prototype.isMembershipListsEnabled = function() {
    return this.membershipLists.enabled;
};

IrcServer.prototype.getMembershipListRules = function() {
    return this.membershipLists;
};

IrcServer.prototype.shouldMirrorIrcJoinParts = function() {
    return this.mirrorIrcJoinParts;
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
            "$CHANNEL": "([^:]*)"
        },
        ":.*"
    );
    var match = new RegExp(regex).exec(alias);
    if (!match) {
        return null;
    }
    log.info("getChannelFromAlias -> %s -> %s -> %s", alias, regex, match[1]);
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
