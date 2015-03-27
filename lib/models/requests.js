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
var logging = require("../logging")
var log = logging.get("req");

 // valid error codes to fail a request
module.exports.ERR_VIRTUAL_USER = "virtual-user";


module.exports.newRequest = function() {
    var request = {
        log: logging.newRequestLogger(log),
        defer: q.defer(),
        start: Date.now()
    };
    request.defer.promise.done(function() {
        request.finished = true;
        var delta = Date.now() - request.start;
        request.log.debug("SUCCESS - %s ms", delta);
    }, function(err) {
        request.finished = true;
        if (err === module.exports.ERR_VIRTUAL_USER) {
            request.log.debug("IGNORED - Sender is a virtual user.");
            return;
        }
        var delta = Date.now() - request.start;
        request.log.debug("FAILED - %s ms (%s)", delta, JSON.stringify(err));
    });
    // useful for debugging as well in case we miss a resolve/reject somewhere.
    setTimeout(function() {
        if (!request.finished) {
            request.log.error("DELAYED - Taking too long.");
        }
    }, 5000);
    return request;
};