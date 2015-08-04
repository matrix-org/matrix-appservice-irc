/*
 * Sends stats to a statsd configured endpoint.
 */
"use strict";

var dgram = require('dgram');
var log = require("../logging").get("stats");

var client = dgram.createSocket('udp4');
var endpoint = null;

module.exports.setEndpoint = function(newEndpoint) {
    endpoint = newEndpoint;
    log.info("statsd endpoint: %s", JSON.stringify(endpoint));
    if (endpoint) {
        // start monitoring memory usage
        sendMemoryUsage();
    }
};

var sendStat = function(metricName, value, type) {
    if (!endpoint) {
        return;
    }
    var msg = new Buffer(metricName + ":" + value + "|" + type);
    client.send(msg, 0, msg.length, endpoint.port, endpoint.hostname,
    function(err) {
        if (err) {
            log.error(err);
            if (err.stack) {
                log.error(err.stack);
            }
        }
    });
};

var sendMemoryUsage = function() {
    setTimeout(function() {
        var info = process.memoryUsage();
        Object.keys(info).forEach(function(key) {
            sendStat("ircas." + process.pid + ".mem." + key, info[key], "g");
        });
        sendMemoryUsage();
    }, (1000 * 60)); // 1 min
};

module.exports.ircClients = function(domain, numConnectedClients) {
    // ircas.<pid>.irc.clients.connected.<domain>
    sendStat(
        "ircas." + process.pid + ".irc.clients.connected." + domain,
        numConnectedClients,
        "g"
    );
};

module.exports.request = function(isFromIrc, outcome, durationMs) {
    // ircas.<pid>.req.<dir>.<outcome>
    // e.g. ircas.1234.req.toIrc.success
    var direction = (isFromIrc ? "fromirc" : "toirc");
    sendStat(
        "ircas." + process.pid + ".req." + direction + "." + outcome,
        durationMs,
        "ms"
    );
};
