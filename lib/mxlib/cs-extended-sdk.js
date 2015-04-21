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
//      inRateLimitMode: true|false
//  }
};
var purgeFrontOfQueue = function(key, log, controlLoop) {
    // take the most recent entry in the queue and give it a shot:
    //  - If we don't get rate limited then yay, do another.
    //  - If we do get rate limited then it'll be re-executed until it either
    //    passes or fails.
    var msgObj = rateLimitQueue[key].queue[0];
    if (!msgObj) {
        // nothing else to do.
        log.info("Finished rate limit backlog for %s", key);
        rateLimitQueue[key].inRateLimitMode = false;
    }
    else {
        log.info("Retrying front of queue for %s", key);
        var promise = doRequest(
            msgObj.opts, msgObj.callback, msgObj.defer, true
        );
        if (controlLoop) {
            promise.done(function() {
                // take next
                log.info("Success! Removed front of queue.");
                rateLimitQueue[key].queue.shift();
                purgeFrontOfQueue(key, log, true);
            }, function(err) {
                // take another (rate limits won't invoke a rejection)
                log.info("Rejected! Removed front of queue.");
                rateLimitQueue[key].queue.shift();
                purgeFrontOfQueue(key, log, true);
            });
        }
    }
};
var invokeRateLimiting = function(timeoutMs, key, opts, callback, defer, log) {
    /* Rate limit strategy
     * We want to send requests in the order we originally received them. We do
     * not want to needlessly thrash by retrying all the queued requests. Rate
     * limiting applies per user_id, so queues are based on user_id.
     * Algorithm:
     * 1. A request receives M_LIMIT_EXCEEDED for user_id 'usr'.
     * 2. The rate-limited request gets added to the queue (first entry).
     * 3. A bit is flipped to say "usr is now in rate limiting mode". *ALL*
     *    subsequent requests from usr are added to the end of the queue without
     *    being attempted.
     * 4. A timer is started based on retry_after_ms.
     * 5. The timer expires. The front of the queue is retried.
     * 6. If the request succeeds, the entry is removed from the queue and the
     *    next entry is attempted. If the request fails, a timer is started
     *    again based on retry_after_ms. Go to step 5.
     * 7. There are no more requests to attempt. The bit is flipped to say "usr
     *    is not in rate limiting mode anymore".
     */
    if (isInRateLimitMode(key)) {
        // we're already in rate limiting mode and we've retried, so we must
        // be the head of the queue. Retry our request after the timer expires.
        log.debug("Retried request still failed.");
        setTimeout(function() {
            logger.info(
                "Retrying front of bucket %s (%s backlog)",
                key, rateLimitQueue[key].queue.length
            );
            // don't control the loop here else we'll pop multiple requests on
            // completion by attaching multiple .done() callbacks!
            purgeFrontOfQueue(key, log, false);
        }, timeoutMs);
    }
    else {
        log.debug(
            "Adding request to rate limit bucket %s. Starting rate limit mode.",
            key
        );
        addToRateLimitQueue(key, opts, callback, defer);
        rateLimitQueue[key].inRateLimitMode = true;
        setTimeout(function() {
            log.info(
                "Purging bucket %s (%s backlog)",
                key, rateLimitQueue[key].queue.length
            );
            purgeFrontOfQueue(key, log, true);
        }, timeoutMs);
    }
};

var addToRateLimitQueue = function(key, opts, callback, defer) {
    // blob together the args for the request fn
    var rateLimitObj = {
        opts: opts,
        callback: callback,
        defer: defer
    };
    // create the struct
    if (!rateLimitQueue[key]) {
        rateLimitQueue[key] = {
            queue: [],
            inRateLimitMode: false
        };
    }
    // add the entry
    rateLimitQueue[key].queue.push(rateLimitObj);
};

var isInRateLimitMode = function(key) {
    return rateLimitQueue[key] ? rateLimitQueue[key].inRateLimitMode : false;
};

var doRequest = function(opts, callback, defer, skipRateLimitCheck) {
    defer = defer || q.defer();
    var userId = opts._matrix_credentials.userId;
    if (userId) {
        opts.qs.user_id = userId;
    }
    opts.qs.access_token = opts._matrix_credentials.accessToken;
    var req = modelRequests.findRequest(opts._matrix_credentials._reqId);
    var log = (req ? req.log : logger);

    var rateLimitKey = opts.qs.user_id || "bot";
    if (!skipRateLimitCheck) {
        if (isInRateLimitMode(rateLimitKey)) {
            log.debug("Adding request to rate limit bucket %s", rateLimitKey);
            addToRateLimitQueue(rateLimitKey, opts, callback, defer);
            return defer.promise;
        }
    }

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
                invokeRateLimiting(
                    retryAfterMs, rateLimitKey, opts, callback, defer, log
                );
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