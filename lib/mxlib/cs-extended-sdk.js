/*
 * Wraps the matrix-js-sdk to provide Extended CS API functionality as outlined
 * in http://matrix.org/docs/spec/#client-server-v2-api-extensions
 */
"use strict";
var extend = require("extend");
var request = require("request");
var q = require("q");

var matrixSdk = require("matrix-js-sdk");
var log = require("../logging").get("matrix-js-sdk");

var baseClientConfig;
var clients = {
    // user_id: { request_id: Client }
};

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
        var httpCode = response.statusCode;
        if (err) {
            log.error("%s %s %s HTTP %s Error: %s", opts.method, opts.uri, 
                userId ? "("+userId+")" : "(AS)", httpCode,
                JSON.stringify(err));
            defer.reject(err);
            return;
        }
        if (httpCode >= 400) {
            log.error("%s %s %s HTTP %s Error: %s", opts.method, opts.uri, 
                userId ? "("+userId+")" : "(AS)", httpCode,
                JSON.stringify(body));
            defer.reject(body);
        }
        else {
            log.debug("HTTP %s : %s", httpCode, JSON.stringify(body));
            defer.resolve(body);
        }
    });
    return defer.promise;
});

// This section allows the caller to extract an SDK client for a given request
// ID. This is much more useful because it means we can log outgoing requests
// with the request ID. In order to do this though, we need to contort how an
// sdk client is obtained.
module.exports.getClientAs = function(userId, requestId) {
    if (!userId) {
        return clients["bot"];
    }

    if (clients[userId]) {
        return clients[userId];
    }
    clients[userId] = matrixSdk.createClient(extend({
        userId: userId
    }, baseClientConfig));
    return clients[userId];
};

module.exports.setClientConfig = function(config) {
    baseClientConfig = config; // home server url, access token, etc
    clients["bot"] = matrixSdk.createClient(baseClientConfig);
};