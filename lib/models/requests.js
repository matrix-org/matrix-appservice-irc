/*
 * A request is effectively an incoming action from either Matrix or IRC. This
 * is specifically NOT HTTP requests given transactions can have many events
 * in them, and IRC is just a TCP stream.
 *
 * Each request needs to be accounted for, so this file manages the requests
 * over its lifetime, specifically for logging.
 */
"use strict";

var q = require("q");
var matrixLib = require("../mxlib/matrix");
var ircLib = require("../irclib/irc");
var stats = require("../config/stats");
var logging = require("../logging");
var log = logging.get("req");

var DELAY_TIMEOUT_MS = 10000;
var DEAD_TIMEOUT_MS = 1000 * 60 * 5; // 5min

/**
 * Construct a request (internal only)
 * @constructor
 * @param {string} requestId : The generated ID for the request.
 * @param {Deferred} deferred : The deffered to be resolved/rejects based on the
 * outcome of the request.
 * @param {Object} logger : The logger to use in the context of this request.
 * @param {boolean} isFromIrc : True if this request came from IRC.
 */
function Request(requestId, deferred, logger, isFromIrc) {
    this.id = requestId;
    this.defer = deferred;
    this.log = logger;
    this.isFromIrc = isFromIrc;
    this.start = Date.now();
}

 // valid error codes to fail a request
module.exports.ERR_VIRTUAL_USER = "virtual-user";

var outstandingRequests = {
    // request_id : Request
};
// find an outstanding request
module.exports.findRequest = function(requestId) {
    return outstandingRequests[requestId];
};

/**
 * Create a new request.
 * @param {boolean} isFromIrc : True if this request originated from IRC.
 * @return {Request} A new request.
 */
module.exports.newRequest = function(isFromIrc) {
    var requestId = generateRequestId();
    var logger = logging.newRequestLogger(log, requestId, isFromIrc);
    var request = new Request(requestId, q.defer(), logger, isFromIrc);
    outstandingRequests[requestId] = request;

    // expose an error handler to prevent defer boilerplate leaking everywhere
    request.errFn = function(err) {
        if (err.stack) {
            request.log.error(err.stack);
        }
        request.defer.reject(err);
    };
    request.sucFn = function() {
        request.defer.resolve();
    };

    request.defer.promise.done(function() {
        request.finished = true;
        var delta = Date.now() - request.start;
        request.log.debug("SUCCESS - %s ms", delta);
        stats.request(request.isFromIrc, "success", delta);
        delete outstandingRequests[requestId];
    }, function(err) {
        request.finished = true;
        var delta = Date.now() - request.start;
        delete outstandingRequests[requestId];
        if (err === module.exports.ERR_VIRTUAL_USER) {
            request.log.debug("IGNORED - %s ms (Sender is a virtual user.)",
                delta);
            return;
        }
        stats.request(request.isFromIrc, "fail", delta);
        request.log.debug("FAILED - %s ms (%s)", delta, JSON.stringify(err));
    });
    // useful for debugging as well in case we miss a resolve/reject somewhere.
    setTimeout(function() {
        if (!request.finished) {
            var delta = Date.now() - request.start;
            stats.request(request.isFromIrc, "delay", delta);
            request.log.error(
                "DELAYED - Taking too long. (>%sms)", DELAY_TIMEOUT_MS
            );
            // start another much longer timer after which point we decide that
            // the request is dead in the water
            setTimeout(function() {
                if (request.finished) {
                    return;
                }
                request.log.error(
                    "DEAD - Removing request (>%sms)",
                    (DELAY_TIMEOUT_MS + DEAD_TIMEOUT_MS)
                );
                stats.request(request.isFromIrc, "fail", delta);
            }, DEAD_TIMEOUT_MS);
        }
    }, DELAY_TIMEOUT_MS);

    request.mxLib = matrixLib.getMatrixLibFor(request);
    request.ircLib = ircLib.getIrcLibFor(request);

    return request;
};

var generateRequestId = function() {
    return (Math.random() * 1e20).toString(36);
};
