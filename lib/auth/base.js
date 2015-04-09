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
var authServer = require("./server");
var store = require("../store");
var Session = require("./session");
var log = require("../logging").get("auth");

module.exports.ERR_FORBIDDEN = "forbidden";
module.exports.ERR_NETWORK = "bad-network";
module.exports.ERR_NO_AUTH_NEEDED = "no-auth-needed";
module.exports.ERR_UNKNOWN = "unknown-auth-failure";
module.exports.ERR_NO_SESSION = "no-session";

// this is called when users try to join a channel which requires auth
module.exports.createSession = function(userId, ircServer) {
    if (!ircServer.hasAuth()) {
        return q.reject("Server does not use auth.");
    }
    var d = q.defer();
    var session = new Session(userId, ircServer);
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
    var d = q.defer();
    store.getSessionByToken(sessionToken).done(function(session) {
        if (!session) {
            d.reject({
                msg: "Session not found.",
                code: module.exports.ERR_NO_SESSION
            });
            return;
        }
        log.info("Found session: %s", JSON.stringify(session));
        var ircServer = session.server;
        if (!ircServer || !ircServer.hasAuth()) {
            d.reject({
                msg: "Server doesn't require auth.",
                code: module.exports.ERR_NO_AUTH_NEEDED
            });
            return;
        }
        switch(ircServer.auth.type) {
            case "cas":
                cas.validate(
                    ircServer.auth.url,
                    getRedirectUrl(sessionToken),
                    authToken
                ).done(function(authInfo) {
                    session.setAuthed(
                        ircServer.auth.type, authInfo.user, 
                        (1000*ircServer.auth.lifetime), Date.now()
                    );
                    store.storeSession(session).done(function() {
                        d.resolve(session);
                    }, function(e) {
                        d.reject(e);
                    });
                }, function(e) {
                    d.reject(e);
                });
                break;
            case "oauth2":
                d.reject({
                    msg: "Not supported yet",
                    code: module.exports.ERR_UNKNOWN
                });
                break;
            default:
                d.reject({
                    msg: "Unknown auth type: "+ircServer.auth.type,
                    code: module.exports.ERR_UNKNOWN
                });
                break;
        }
    }, function(e) {
        log.error("validation failure: token=%s err=%s", sessionToken,
            JSON.stringify(e));
        d.reject({
            msg: "Session not found.",
            code: module.exports.ERR_NO_SESSION
        });
    });
    return d.promise;
};

var getRedirectUrl = function(token) {
    return authServer.redirectBase + "/" + token;
};

// called when an unauthorised user wants to access authorised content
var getAuthUrl = function(ircServer, token) {
    switch(ircServer.auth.type) {
        case "cas":
            return cas.getAuthUrl(
                ircServer.auth.url, getRedirectUrl(token)
            );
        case "oauth2":
            return;
        default:
            return;
    }
};