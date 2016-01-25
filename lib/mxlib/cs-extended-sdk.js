/*
 * Wraps the matrix-js-sdk to provide Extended CS API functionality as outlined
 * in http://matrix.org/docs/spec/#client-server-v2-api-extensions
 */
"use strict";

var extend = require("extend");
var request = require("request");
var matrixSdk = require("matrix-js-sdk");

var modelRequests = require("../models/requests");
var logger = require("../logging").get("matrix-js-sdk");

var baseClientConfig;
var clients = {
    // request_id: {
    //   user_id: Client
    // }
};

var doRequest = function(opts, callback) {
    var req = modelRequests.findRequest(opts._matrix_opts._reqId);
    var log = (req ? req.log : logger);

    log.debug("%s %s %s Body: %s", opts.method, opts.uri,
        opts.qs.user_id ? "(" + opts.qs.user_id + ")" : "(AS)",
        opts.body ? JSON.stringify(opts.body).substring(0, 80) : "");
    request(opts, function(err, response, body) {
        logResponse(log, opts, err, response, body);
        callback(err, response, body);
    });
};
matrixSdk.request(doRequest);

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
        userId: userId,
        queryParams: {
            user_id: userId
        }
    }, baseClientConfig));
    client._http.opts._reqId = requestId;
    setClientForRequest(requestId, userIdKey, client);
    return client;
};

module.exports.setClientConfig = function(config) {
    baseClientConfig = config; // home server url, access token, etc
    setClientForRequest("-", "bot", matrixSdk.createClient(extend({
        // force set access_token= so it is used when /register'ing
        queryParams: { access_token: baseClientConfig.accessToken }
        },
        baseClientConfig
    )));
};

function setClientForRequest(requestId, userIdKey, sdkClient) {
    if (!clients[requestId]) {
        clients[requestId] = {};
    }
    sdkClient.credentials._reqId = requestId;
    clients[requestId][userIdKey] = sdkClient;
}

function getClientForRequest(requestId, userIdKey) {
    if (clients[requestId] && clients[requestId][userIdKey]) {
        return clients[requestId][userIdKey];
    }
}

function logResponse(log, opts, err, response, body) {
    var httpCode = response ? response.statusCode : null;
    var userId = opts.qs ? (opts.qs.user_id || null) : null;
    if (err) {
        log.error("%s %s %s HTTP %s Error: %s", opts.method, opts.uri,
            userId ? "(" + userId + ")" : "(AS)", httpCode,
            JSON.stringify(err));
        return;
    }
    if (httpCode >= 300 || httpCode < 200) {
        log.error("%s %s %s HTTP %s Error: %s", opts.method, opts.uri,
            userId ? "(" + userId + ")" : "(AS)", httpCode,
            JSON.stringify(body));
    }
    else {
        log.debug( // body may be large, so do first 80 chars
            "HTTP %s : %s", httpCode, JSON.stringify(body).substring(0, 80)
        );
    }
}
