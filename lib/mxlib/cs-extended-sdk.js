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

matrixSdk.request(function(opts, callback) {
    var userId = opts._matrix_credentials.userId;
    if (userId) {
        opts.qs.user_id = userId;
    }
    opts.qs.access_token = opts._matrix_credentials.accessToken;

    log.debug("%s %s %s Body: %s", opts.method, opts.uri, 
        userId ? "("+userId+")" : "(AS)",
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