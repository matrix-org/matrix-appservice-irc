/*
 * Provides mechanisms for kerboroz token-based authentication.
 */
"use strict";
var q = require("q");
var cas = require("./cas");

module.exports.ERR_FORBIDDEN = "forbidden";
module.exports.ERR_NETWORK = "bad-network";
module.exports.ERR_NO_AUTH_NEEDED = "no-auth-needed";
module.exports.ERR_UNKNOWN = "unknown-auth-failure";

// validate the redirected response.
module.exports.validate = function(ircServer, token) {
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
                token
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

// called when an unauthorised user wants to access authorised content
module.exports.getAuthUrl = function(ircServer) {
    if (!ircServer.auth || !ircServer.auth.url || !ircServer.auth.redirect) {
        return;
    }
    switch(ircServer.auth.type) {
        case "cas":
            return cas.getAuthUrl(ircServer.auth.url, ircServer.auth.redirect);
        case "oauth2":
            return;
        default:
            return;
    }
};