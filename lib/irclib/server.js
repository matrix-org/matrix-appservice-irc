/*
 * Represents a single IRC server.
 */
"use strict";
var logging = require("../logging");
var log = logging.get("irc-server");

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
