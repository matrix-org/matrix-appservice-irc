/*
 * Provides auth mechanisms for CAS.
 */
"use strict";
var q = require("q");
var request = require("request");

var auth = require("./base");

module.exports.validate = function(baseUrl, redirectUrl, token) {
    var defer = q.defer();

    var opts = {
        uri: baseUrl+"/validate",
        method: "GET",
        qs: {
            ticket: token,
            service: redirectUrl
        }
    };

    request(opts, function(err, response, body) {
        if (err) {
            defer.reject({
                msg: JSON.stringify(err),
                code: auth.ERR_NETWORK
            });
            return;
        }
        var sections = body.split("\n");
        if (sections.length === 0) {
            defer.reject({
                msg: "Bad response format",
                code: auth.ERR_UNKNOWN
            });
            return;
        }
        if (sections[0] == "no") {
            defer.reject({
                msg: "Authorisation failure",
                code: auth.ERR_FORBIDDEN
            })
        }
        else if (sections[0] == "yes" && sections.length > 1) {
            defer.resolve({
                user: sections[1]
            });
        }
    });

    return defer.promise;
};

module.exports.getAuthUrl = function(baseUrl, redirectUrl) {
    return baseUrl + "/login?service=" + encodeURIComponent(redirectUrl);
};