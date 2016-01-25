/*
 * Sends stats to a statsd configured endpoint.
 */
"use strict";

var dgram = require('dgram');
var log = require("../logging").get("stats");

var client = dgram.createSocket('udp4');
var endpoint = null;
var jobName = "ircasinstance";

module.exports.setEndpoint = function(newEndpoint) {
    endpoint = newEndpoint;
    // replace non A-z0-9 chars to avoid the job name potentially altering
    // the statsd metric structure (where . is important)
    jobName = (newEndpoint.jobName || jobName).replace(/[^A-Za-z0-9]/g, "");
    log.info("statsd endpoint: %s (name: %s)", JSON.stringify(endpoint), jobName);
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

function sendMemoryUsage() {
    setTimeout(function() {
        var info = process.memoryUsage();
        Object.keys(info).forEach(function(key) {
            sendStat("ircas." + jobName + ".mem." + key, info[key], "g");
        });
        sendMemoryUsage();
    }, (1000 * 60)); // 1 min
}

module.exports.ircClients = function(domain, numConnectedClients) {
    // ircas.<job_name>.irc.clients.connected.<domain>
    sendStat(
        "ircas." + jobName + ".irc.clients.connected." + domain.replace(/\./g, "_"),
        numConnectedClients,
        "g"
    );
};

module.exports.request = function(isFromIrc, outcome, durationMs) {
    // ircas.<job_name>.req.<dir>.<outcome>
    // e.g. ircas.1234.req.toIrc.success
    var direction = (isFromIrc ? "fromirc" : "toirc");
    sendStat(
        "ircas." + jobName + ".req." + direction + "." + outcome,
        durationMs,
        "ms"
    );
};
