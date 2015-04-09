/*
 * Provides mechanisms for kerboroz token-based authentication.
 *
 * +------+         +-----------+
 * | Auth |<---6----|  IRC      |
 * |Server|----7--->|AppService |
 * +------+         +-----------+
 *   |  ^             ^   |   ^
 *   |  |             |   |   |
 *   4  3             5   2   1
 *   |  |             |   |   |
 *   |  |             |   V   |
 *   |  |           +-----------+
 *   |  +-----------|   Client  |
 *   +------------->|           |
 *                  +-----------+
 *
 *  1=Client tries "/join irc.example.com #somechannel"
 *  2=AS creates session. Sends m.notice with URI to the server to auth with.
 *  3=Client clicks link and logs in.
 *  4=Auth server 302s back to the AS with a token.
 *  5=Client performs the redirect.
 *  6=AS tries to auth with the token received.
 *  7=Auth server says yay/nay. AS deletes session.
 *
 * The process for how the AS handles state is as follows:
 * - createSession stores the user_id + irc server to auth + random token. One
 *   session can be made per user_id/irc server tuple (they clobber).
 * - The token is suffixed as a path segment to the irc server specific redirect
 *   URI specified in config.yaml
 * - On incoming redirections, the session token is stripped out the URL and
 *   used to extract the user_id / irc server being authed.
 */
"use strict";
var q = require("q");

var cas = require("./cas");
var store = require("../store");
var Session = require("./session");

module.exports.ERR_FORBIDDEN = "forbidden";
module.exports.ERR_NETWORK = "bad-network";
module.exports.ERR_NO_AUTH_NEEDED = "no-auth-needed";
module.exports.ERR_UNKNOWN = "unknown-auth-failure";

// this is called when users try to join a channel which requires auth
module.exports.createSession = function(userId, ircServer) {
    var d = q.defer();
    var session = new Session(userId, ircServer.domain);
    // Clobber any existing session for this user_id/irc_network tuple.
    store.storeSession(session).done(function() {
        d.resolve({
            session: session,
            url: getAuthUrl(ircServer, session.token)
        });
    }, function(err) {
        d.reject(err);
    });
    // Make auth url with session token.
    return d.promise;
};

// this is called when the AS receives the redirected response.
module.exports.validate = function(sessionToken, authToken) {
    // TODO: Extract the ircServer / userId from the session.

    if (!ircServer.auth || !ircServer.auth.url || !ircServer.auth.redirect) {
        return q.reject({
            msg: "Server doesn't require auth.",
            code: module.exports.ERR_NO_AUTH_NEEDED
        });
    }

    switch(ircServer.auth.type) {
        case "cas":
            return cas.validate(
                ircServer.auth.url, 
                ircServer.auth.redirect,
                authToken
            );
        case "oauth2":
            return q.reject({
                msg: "Not supported yet",
                code: module.exports.ERR_UNKNOWN
            });
        default:
            return q.reject({
                msg: "Unknown auth type: "+ircServer.auth.type,
                code: module.exports.ERR_UNKNOWN
            });
    }
};

var getSession = function(sessionToken) {
    // TODO: return session from database
};

// called when an unauthorised user wants to access authorised content
var getAuthUrl = function(ircServer, token) {
    if (!ircServer.auth || !ircServer.auth.url || !ircServer.auth.redirect) {
        return;
    }
    var base = null;
    switch(ircServer.auth.type) {
        case "cas":
            base = cas.getAuthUrl(ircServer.auth.url, ircServer.auth.redirect);
            break;
        case "oauth2":
            return;
        default:
            return;
    }
    if (base) {
        return base + "/" + token;
    }
};