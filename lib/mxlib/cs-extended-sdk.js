/*
 * Wraps the matrix-js-sdk to provide Extended CS API functionality as outlined
 * in http://matrix.org/docs/spec/#client-server-v2-api-extensions
 */
"use strict";
var extend = require("extend");
var request = require("request");
var q = require("q");
var matrixSdk = require("matrix-js-sdk");

var modelRequests = require("../models/requests");
var logger = require("../logging").get("matrix-js-sdk");

var baseClientConfig;
var clients = {
    // request_id: {
    //   user_id: Client 
    // }
};

matrixSdk.request(function(opts, callback) {
    var userId = opts._matrix_credentials.userId;
    if (userId) {
        opts.qs.user_id = userId;
    }
    opts.qs.access_token = opts._matrix_credentials.accessToken;
    var req = modelRequests.findRequest(opts._matrix_credentials._reqId);
    var log = (req ? req.log : logger);

    log.debug("%s %s %s Body: %s", opts.method, opts.uri, 
        userId ? "("+userId+")" : "(AS)",
        JSON.stringify(opts.body));
    
    var defer = q.defer();
    request(opts, function(err, response, body) {
        var httpCode = response ? response.statusCode : null;
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
            log.debug( // body may be large, so do first 80 chars
                "HTTP %s : %s", httpCode, JSON.stringify(body).substring(0, 80)
            );
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
    requestId = requestId || "-"; // default request ID
    var userIdKey = userId || "bot"; // no user ID = the bot

    // see if there is an existing match
    var client = getClientForRequest(requestId, userIdKey);
    if (client) {
        return client;
    }

    // add a listener for the completion of this request so we can cleanup
    // the clients we've made
    var req = modelRequests.findRequest(requestId);
    if (req) {
        req.defer.promise.finally(function() {
            delete clients[requestId];
        });
    }

    // store a new client and return that
    client = matrixSdk.createClient(extend({
        userId: userId
    }, baseClientConfig));
    setClientForRequest(requestId, userIdKey, client);
    return client;
};

module.exports.setClientConfig = function(config) {
    baseClientConfig = config; // home server url, access token, etc
    setClientForRequest("-", "bot", matrixSdk.createClient(baseClientConfig));
};

var setClientForRequest = function(requestId, userIdKey, sdkClient) {
    if (!clients[requestId]) {
        clients[requestId] = {};
    }
    sdkClient.credentials._reqId = requestId;
    clients[requestId][userIdKey] = sdkClient;
};

var getClientForRequest = function(requestId, userIdKey) {
    if (clients[requestId] && clients[requestId][userIdKey]) {
        return clients[requestId][userIdKey];
    }
};