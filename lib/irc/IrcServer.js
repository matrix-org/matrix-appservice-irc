/*
 * Represents a single IRC server from config.yaml
 */
"use strict";
var logging = require("../logging");
var IrcClientConfig = require("../models/IrcClientConfig");
var log = logging.get("IrcServer");

/**
 * Construct a new IRC Server.
 * @constructor
 * @param {string} domain : The IRC network address
 * @param {Object} serverConfig : The config options for this network.
 * @param {string} homeserverDomain : The domain of the homeserver
 * e.g "matrix.org"
 * @param {Number} expiryTimeSeconds : How old a matrix message can be
 * before it is considered 'expired' and not sent to IRC. If 0, messages
 * will never expire.
 */
function IrcServer(domain, serverConfig, homeserverDomain, expiryTimeSeconds) {
    this.domain = domain;
    this.config = serverConfig;

    this._addresses = serverConfig.additionalAddresses;
    if (!this._addresses) {
        this._addresses = [];
    }
    this._addresses.push(domain);
    this._homeserverDomain = homeserverDomain;
    this._expiryTimeSeconds = expiryTimeSeconds;
}

/**
 * Get how old a matrix message can be (in seconds) before it is considered
 * 'expired' and not sent to IRC.
 * @return {Number} The number of seconds. If 0, they never expire.
 */
IrcServer.prototype.getExpiryTimeSeconds = function() {
    return this._expiryTimeSeconds || 0;
}

/**
 * Get a string that represents the human-readable name for a server.
 * @return {string} this.config.name if truthy, otherwise it will return
 * an empty string.
 */
IrcServer.prototype.getReadableName = function() {
    let name = this.config.name;
    if (name) {
        return name;
    }

    return '';
}

/**
 * Return a randomised server domain from the default and additional addresses.
 * @return {string}
 */
IrcServer.prototype.randomDomain = function() {
    return this._addresses[
        Math.floor((Math.random() * 1000) % this._addresses.length)
    ];
}

/**
 * Returns the network ID of this server, which should be unique across all
 * IrcServers on the bridge. Defaults to the domain of this IrcServer.
 * @return {string} this.config.networkId || this.domain
 */
IrcServer.prototype.getNetworkId = function() {
    return this.config.networkId || this.domain;
}

/**
 * Returns whether the server is configured to wait getQuitDebounceDelayMs before
 * parting a user that has disconnected due to a net-split.
 * @return {Boolean} this.config.quitDebounce.enabled.
 */
IrcServer.prototype.shouldDebounceQuits = function() {
    return this.config.quitDebounce.enabled;
}

/**
 * Get the minimum number of ms to debounce before bridging a QUIT to Matrix
 * during a detected net-split. If the user rejoins a channel before bridging
 * the quit to a leave, the leave will not be sent.
 * @return {number}
 */
IrcServer.prototype.getQuitDebounceDelayMinMs = function() {
    return this.config.quitDebounce.delayMinMs;
}

/**
 * Get the maximum number of ms to debounce before bridging a QUIT to Matrix
 * during a detected net-split. If a leave is bridged, it will occur at a
 * random time between delayMinMs (see above) delayMaxMs.
 * @return {number}
 */
IrcServer.prototype.getQuitDebounceDelayMaxMs = function() {
    return this.config.quitDebounce.delayMaxMs;
}

/**
 * Get the rate of maximum quits received per second before a net-split is
 * detected. If the rate of quits received becomes higher that this value,
 * a net split is considered ongoing.
 * @return {number}
 */
IrcServer.prototype.getDebounceQuitsPerSecond = function() {
    return this.config.quitDebounce.quitsPerSecond;
}

/**
 * Get a map that converts IRC user modes to Matrix power levels.
 * @return {Object}
 */
IrcServer.prototype.getModePowerMap = function() {
    return this.config.modePowerMap || {};
}

IrcServer.prototype.getHardCodedRoomIds = function() {
    var roomIds = new Set();
    var channels = Object.keys(this.config.mappings);
    channels.forEach((chan) => {
        this.config.mappings[chan].forEach((roomId) => {
            roomIds.add(roomId);
        });
    });
    return Array.from(roomIds.keys());
};

IrcServer.prototype.shouldSendConnectionNotices = function() {
    return this.config.sendConnectionMessages;
};

IrcServer.prototype.isBotEnabled = function() {
    return this.config.botConfig.enabled;
};

IrcServer.prototype.getUserModes = function() {
    return this.config.ircClients.userModes || "";
}

IrcServer.prototype.getJoinRule = function() {
    return this.config.dynamicChannels.joinRule;
};

IrcServer.prototype.shouldFederatePMs = function() {
    return this.config.privateMessages.federate;
};

IrcServer.prototype.getMemberListFloodDelayMs = function() {
    return this.config.membershipLists.floodDelayMs;
};

IrcServer.prototype.shouldFederate = function() {
    return this.config.dynamicChannels.federate;
};

IrcServer.prototype.getPort = function() {
    return this.config.port;
};

IrcServer.prototype.isInWhitelist = function(userId) {
    return this.config.dynamicChannels.whitelist.indexOf(userId) !== -1;
};

IrcServer.prototype.getCA = function() {
    return this.config.ca;
};

IrcServer.prototype.useSsl = function() {
    return Boolean(this.config.ssl);
};

IrcServer.prototype.useSslSelfSigned = function() {
    return Boolean(this.config.sslselfsign);
};

IrcServer.prototype.getIdleTimeout = function() {
    return this.config.ircClients.idleTimeout;
};

IrcServer.prototype.getReconnectIntervalMs = function() {
    return this.config.ircClients.reconnectIntervalMs;
};

IrcServer.prototype.getMaxClients = function() {
    return this.config.ircClients.maxClients;
};

IrcServer.prototype.shouldPublishRooms = function() {
    return this.config.dynamicChannels.published;
};

IrcServer.prototype.allowsNickChanges = function() {
    return this.config.ircClients.allowNickChanges;
};

IrcServer.prototype.createBotIrcClientConfig = function(username) {
    return IrcClientConfig.newConfig(
        null, this.domain, this.config.botConfig.nick, username,
        this.config.botConfig.password
    );
};

IrcServer.prototype.getIpv6Prefix = function() {
    return this.config.ircClients.ipv6.prefix;
};

IrcServer.prototype.getIpv6Only = function() {
    return this.config.ircClients.ipv6.only;
};

IrcServer.prototype.getLineLimit = function() {
    return this.config.ircClients.lineLimit;
};

IrcServer.prototype.isExcludedChannel = function(channel) {
    return this.config.dynamicChannels.exclude.indexOf(channel) !== -1;
};

IrcServer.prototype.hasInviteRooms = function() {
    return (
        this.config.dynamicChannels.enabled && this.getJoinRule() === "invite"
    );
};

// check if this server dynamically create rooms with aliases.
IrcServer.prototype.createsDynamicAliases = function() {
    return (
        this.config.dynamicChannels.enabled &&
        this.config.dynamicChannels.createAlias
    );
};

// check if this server dynamically creates rooms which are joinable via an alias only.
IrcServer.prototype.createsPublicAliases = function() {
    return (
        this.createsDynamicAliases() &&
        this.getJoinRule() === "public"
    );
};

IrcServer.prototype.allowsPms = function() {
    return this.config.privateMessages.enabled;
};

IrcServer.prototype.shouldSyncMembershipToIrc = function(kind, roomId) {
    return this._shouldSyncMembership(kind, roomId, true);
};

IrcServer.prototype.shouldSyncMembershipToMatrix = function(kind, channel) {
    return this._shouldSyncMembership(kind, channel, false);
};

IrcServer.prototype._shouldSyncMembership = function(kind, identifier, toIrc) {
    if (["incremental", "initial"].indexOf(kind) === -1) {
        throw new Error("Bad kind: " + kind);
    }
    if (!this.config.membershipLists.enabled) {
        return false;
    }
    var shouldSync = this.config.membershipLists.global[
        toIrc ? "matrixToIrc" : "ircToMatrix"
    ][kind];

    if (!identifier) {
        return shouldSync;
    }

    // check for specific rules for the room id / channel
    if (toIrc) {
        // room rules clobber global rules
        this.config.membershipLists.rooms.forEach(function(r) {
            if (r.room === identifier && r.matrixToIrc) {
                shouldSync = r.matrixToIrc[kind];
            }
        });
    }
    else {
        // channel rules clobber global rules
        this.config.membershipLists.channels.forEach(function(chan) {
            if (chan.channel === identifier && chan.ircToMatrix) {
                shouldSync = chan.ircToMatrix[kind];
            }
        });
    }

    return shouldSync;
};

IrcServer.prototype.shouldJoinChannelsIfNoUsers = function() {
    return this.config.botConfig.joinChannelsIfNoUsers;
};

IrcServer.prototype.isMembershipListsEnabled = function() {
    return this.config.membershipLists.enabled;
};

IrcServer.prototype.getUserLocalpart = function(nick) {
    // the template is just a literal string with special vars; so find/replace
    // the vars and strip the @
    var uid = this.config.matrixClients.userTemplate.replace(/\$SERVER/g, this.domain);
    return uid.replace(/\$NICK/g, nick).substring(1);
};

IrcServer.prototype.claimsUserId = function(userId) {
    // the server claims the given user ID if the ID matches the user ID template.
    var regex = templateToRegex(
        this.config.matrixClients.userTemplate,
        {
            "$SERVER": this.domain
        },
        {
            "$NICK": "(.*)"
        },
        ":" + escapeRegExp(this._homeserverDomain)
    );
    return new RegExp(regex).test(userId);
};

IrcServer.prototype.getNickFromUserId = function(userId) {
    // extract the nick from the given user ID
    var regex = templateToRegex(
        this.config.matrixClients.userTemplate,
        {
            "$SERVER": this.domain
        },
        {
            "$NICK": "(.*?)"
        },
        ":" + escapeRegExp(this._homeserverDomain)
    );
    var match = new RegExp(regex).exec(userId);
    if (!match) {
        return null;
    }
    return match[1];
};

IrcServer.prototype.getUserIdFromNick = function(nick) {
    var template = this.config.matrixClients.userTemplate;
    return template.replace(/\$NICK/g, nick).replace(/\$SERVER/g, this.domain) +
        ":" + this._homeserverDomain;
};

IrcServer.prototype.getDisplayNameFromNick = function(nick) {
    var template = this.config.matrixClients.displayName;
    var displayName = template.replace(/\$NICK/g, nick);
    displayName = displayName.replace(/\$SERVER/g, this.domain);
    return displayName;
};

IrcServer.prototype.claimsAlias = function(alias) {
    // the server claims the given alias if the alias matches the alias template
    var regex = templateToRegex(
        this.config.dynamicChannels.aliasTemplate,
        {
            "$SERVER": this.domain
        },
        {
            "$CHANNEL": "#(.*)"
        },
        ":" + escapeRegExp(this._homeserverDomain)
    );
    return new RegExp(regex).test(alias);
};

IrcServer.prototype.getChannelFromAlias = function(alias) {
    // extract the channel from the given alias
    var regex = templateToRegex(
        this.config.dynamicChannels.aliasTemplate,
        {
            "$SERVER": this.domain
        },
        {
            "$CHANNEL": "([^:]*)"
        },
        ":" + escapeRegExp(this._homeserverDomain)
    );
    var match = new RegExp(regex).exec(alias);
    if (!match) {
        return null;
    }
    log.info("getChannelFromAlias -> %s -> %s -> %s", alias, regex, match[1]);
    return match[1];
};

IrcServer.prototype.getAliasFromChannel = function(channel) {
    var template = this.config.dynamicChannels.aliasTemplate;
    return template.replace(/\$CHANNEL/, channel) + ":" + this._homeserverDomain;
};

IrcServer.prototype.getNick = function(userId, displayName) {
    var localpart = userId.substring(1).split(":")[0];
    var display = displayName || localpart;
    var template = this.config.ircClients.nickTemplate;
    var nick = template.replace(/\$USERID/g, userId);
    nick = nick.replace(/\$LOCALPART/g, localpart);
    nick = nick.replace(/\$DISPLAY/g, display);
    return nick;
};

IrcServer.prototype.getAliasRegex = function() {
    return templateToRegex(
        this.config.dynamicChannels.aliasTemplate,
        {
            "$SERVER": this.domain  // find/replace $server
        },
        {
            "$CHANNEL": ".*"  // the nick is unknown, so replace with a wildcard
        },
        // Only match the domain of the HS
        ":" + escapeRegExp(this._homeserverDomain)
    );
};

IrcServer.prototype.getUserRegex = function() {
    return templateToRegex(
        this.config.matrixClients.userTemplate,
        {
            "$SERVER": this.domain  // find/replace $server
        },
        {
            "$NICK": ".*"  // the nick is unknown, so replace with a wildcard
        },
        // Only match the domain of the HS
        ":" + escapeRegExp(this._homeserverDomain)
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

IrcServer.DEFAULT_CONFIG = {
    sendConnectionMessages: true,
    quitDebounce: {
        enabled: false,
        quitsPerSecond: 5,
        delayMinMs: 3600000, // 1h
        delayMaxMs: 7200000, // 2h
    },
    botConfig: {
        nick: "appservicebot",
        joinChannelsIfNoUsers: true,
        enabled: true
    },
    privateMessages: {
        enabled: true,
        exclude: [],
        federate: true
    },
    dynamicChannels: {
        enabled: false,
        published: true,
        createAlias: true,
        joinRule: "public",
        federate: true,
        aliasTemplate: "#irc_$SERVER_$CHANNEL",
        whitelist: [],
        exclude: []
    },
    mappings: {},
    matrixClients: {
        userTemplate: "@$SERVER_$NICK",
        displayName: "$NICK (IRC)"
    },
    ircClients: {
        nickTemplate: "M-$DISPLAY",
        maxClients: 30,
        idleTimeout: 172800,
        reconnectIntervalMs: 5000,
        allowNickChanges: false,
        ipv6: {only: false},
        lineLimit: 3
    },
    membershipLists: {
        enabled: false,
        floodDelayMs: 10000, // 10s
        global: {
            ircToMatrix: {
                initial: false,
                incremental: false
            },
            matrixToIrc: {
                initial: false,
                incremental: false
            }
        },
        channels: [],
        rooms: []
    }
};

module.exports = IrcServer;
