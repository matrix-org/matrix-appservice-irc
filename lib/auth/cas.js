/*
 * Provides auth mechanisms for CAS.
 */
"use strict";
var q = require("q");
var request = require("request");

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
            defer.reject(err);
            return;
        }
        var sections = body.split("\n");
        if (sections.length === 0) {
            defer.reject({
                msg: "Bad response format"
            });
            return;
        }
        if (sections[0] == "no") {
            defer.reject({
                msg: "Authorisation failure"
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