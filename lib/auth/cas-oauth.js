/*
 * Provides auth mechanisms for OAuth2 and CAS.
 */
"use strict";
var q = require("q");
var cas = require("cas");

// validate the redirected response.
module.exports.validate = function(ircServer, token) {
    if (!ircServer.auth || !ircServer.auth.url || !ircServer.auth.redirect) {
        return q.reject("Server doesn't require auth.");
    }
    var defer = q.defer();

    switch(ircServer.auth.type) {
        case "cas":
            var c = new cas({
                base_url: ircServer.auth.url,
                service: ircServer.auth.redirect
            });
            c.validate(token, function(error, status, user) {
                if (error) {
                    defer.reject(error);
                }
                else if (user) {
                    defer.resolve({
                        user: user
                    });
                }
                else {
                    defer.reject("Failed validation");
                }
            });
        case "oauth2":
            return q.reject("Not supported yet");
        default:
            return q.reject("Unknown auth type: "+ircServer.auth.type);
    }

    return defer.promise;
};

// called when an unauthorised user wants to access authorised content
module.exports.getAuthUrl = function(ircServer) {
    if (!ircServer.auth || !ircServer.auth.url || !ircServer.auth.redirect) {
        return;
    }
    switch(ircServer.auth.type) {
        case "cas":
            return (
                ircServer.auth.url + "/login?service=" + 
                encodeURIComponent(ircServer.auth.redirect)
            );
        case "oauth2":
            return;
        default:
            return;
    }
};