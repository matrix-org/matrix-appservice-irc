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

var rateLimitQueue = {
//  user_id: {
//      queue: []
//      pending: true|false
//  }
};
var invokeRateLimiting = function(timeoutMs, opts, callback, defer) {
    var rateLimitObj = {
        opts: opts,
        callback: callback,
        defer: defer
    };
    // rate limiting applies per user, so bucket them per user.
    var userId = opts.qs.user_id || "bot";
    if (!rateLimitQueue[userId]) {
        rateLimitQueue[userId] = {
            queue: [],
            pending: false
        };
    }
    // chuck it in the queue
    rateLimitQueue[userId].queue.push(rateLimitObj);
    if (!rateLimitQueue[userId].pending) {
        // start a rate limit timer for this user
        setTimeout(function() {
            logger.info(
                "Purging %s queued requests for bucket %s",
                rateLimitQueue[userId].queue.length,
                userId
            );
            rateLimitQueue[userId].pending = false;
            // purge the entire queue:
            //  - If we don't get rate limited then yay
            //  - If we do get rate limited then it'll be re-added to the queue
            //    and another timer will be started.
            var msgQueue = rateLimitQueue[userId].queue;
            rateLimitQueue[userId].queue = [];
            msgQueue.forEach(function(msgObj) {
                doRequest(msgObj.opts, msgObj.callback, msgObj.defer);
            });
        }, timeoutMs);
        rateLimitQueue[userId].pending = true;
    }
};

var doRequest = function(opts, callback, defer) {
    defer = defer || q.defer();
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

    request(opts, function(err, response, body) {
        var httpCode = response ? response.statusCode : null;
        if (err) {
            log.error("%s %s %s HTTP %s Error: %s", opts.method, opts.uri, 
                userId ? "("+userId+")" : "(AS)", httpCode,
                JSON.stringify(err));
            defer.reject(err);
            return;
        }
        if (httpCode >= 300 || httpCode < 200) {
            log.error("%s %s %s HTTP %s Error: %s", opts.method, opts.uri, 
                userId ? "("+userId+")" : "(AS)", httpCode,
                JSON.stringify(body));
            if (httpCode === 429) { // M_LIMIT_EXCEEDED
                var retryAfterMs = (1000 + body.retry_after_ms) || 5000;
                invokeRateLimiting(retryAfterMs, opts, callback, defer);
            }
            else {
                defer.reject(body);
            }
        }
        else {
            log.debug( // body may be large, so do first 80 chars
                "HTTP %s : %s", httpCode, JSON.stringify(body).substring(0, 80)
            );
            defer.resolve(body);
        }
    });

    return defer.promise;
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