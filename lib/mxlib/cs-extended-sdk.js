/*
 * Wraps the matrix-js-sdk to provide Extended CS API functionality as outlined
 * in http://matrix.org/docs/spec/#client-server-v2-api-extensions
 */
"use strict";
var matrixSdk = require("matrix-js-sdk");
var log = require("../logging").get("matrix-js-sdk");
var request = require("request");
var q = require("q");

module.exports.cs = matrixSdk;
module.exports.userId = undefined;
module.exports.accessToken = undefined;

matrixSdk.request(function(opts, callback) {
    if (module.exports.userId) {
        opts.qs.user_id = module.exports.userId;
    }
    if (module.exports.accessToken) {
        opts.qs.access_token = module.exports.accessToken;
    }
    log.debug("%s %s %s Body: %s", opts.method, opts.uri, 
        module.exports.userId ? "("+module.exports.userId+")" : "(AS)",
        JSON.stringify(opts.body));
    
    var defer = q.defer();
    request(opts, function(err, response, body) {
        if (err) {
            defer.reject(err);
            return;
        }
        if (response.statusCode >= 400) {
            defer.reject(body);
        }
        else {
            defer.resolve(body);
        }
    });
    return defer.promise;
});