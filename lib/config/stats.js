/*
 * Sends stats to a statsd configured endpoint.
 */
 "use strict";
var log = require("../logging").get("stats");

var endpoint = null;

 module.exports.setEndpoint = function(url) {
    endpoint = url;
    log.info("statsd endpoint: %s", endpoint);
 }