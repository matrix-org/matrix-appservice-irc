/*
 * Provides mechanisms for kerboroz token-based authentication.
 */
"use strict";
var q = require("q");
var cas = require("./cas");

// validate the redirected response.
module.exports.validate = function(ircServer, token) {
    if (!ircServer.auth || !ircServer.auth.url || !ircServer.auth.redirect) {
        return q.reject("Server doesn't require auth.");
    }

    switch(ircServer.auth.type) {
        case "cas":
            return cas.validate(
                ircServer.auth.url, 
                ircServer.auth.redirect,
                token
            );
        case "oauth2":
            return q.reject("Not supported yet");
        default:
            return q.reject("Unknown auth type: "+ircServer.auth.type);
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