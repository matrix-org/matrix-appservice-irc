/*
 * The purpose of this file is to provide a way of representing users and 
 * convert between them.
 *
 * A user ID represents a Matrix user uniquely.
 * An IRC nick and server domain represent an IRC user uniquely.
 * Some user IDs are special and should NOT be relayed (with the AS user prefix)
 * Some IRC nicks are special and should NOT be relayed (stored IRC mapping)
 */
"use strict";

var extend = require("extend");
var log = require("../logging").get("users");

// Every user MUST have a protocol and 'isVirtual' key, which is 'true' if this
// user isn't a real user on this protocol, but a generated one. The remaining
// keys can vary depending on the protocol.
var createUser = function(protocol, isVirtual, opts) {
    return extend({
        isVirtual: isVirtual,
        protocol: protocol,
    }, opts);
};

module.exports.irc = {
    createUser: function(server, nick, isVirtual) {
        if (nick[0] === "#") {
            return; // channel
        }
        return createUser("irc", isVirtual, {
            server: server,
            nick: nick
        });
    }
};

module.exports.matrix = {
    createUser: function(userId, isVirtual) {
        return createUser("matrix", isVirtual, {
            userId: userId
        });
    },
    createAuthenticatedUser: function(userId, authType, username, authedAtTs, 
                                      timeAuthedForSecs) {
        return createUser("matrix", false, {
            userId: userId,
            auth: {
                ts: authedAtTs,
                type: authType,
                username: username,
                lifetime: timeAuthedForSecs
            }
        })
    }
};