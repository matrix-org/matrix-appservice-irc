/*eslint no-invalid-this: 0*/
"use strict"
var Promise = require("bluebird");
var logging = require("../logging");
var log = logging.get("scheduler");
var Queue = require("../util/Queue.js");

/**
 * An IRC connection scheduler. Enables ConnectionInstance to reconnect
 * in a way that queues reconnection requests and services the FIFO queue at a
 * rate determined by ircServer.getReconnectIntervalMs().
 */

 var queues = {};

function procFn (item) {
    return Promise.delay(item.addedDelayMs).then(item.fn);
}

function getQueue (server) {
    let q = queues[server.domain];

    if (!q) {
        q = new Queue(procFn, server.getReconnectIntervalMs());

        queues[server.domain] = q;
    }
    return q;
}

var Scheduler = {
    // Returns a promise that will be resolved when retryConnection returns a promise that
    //  resolves, in other words, when the connection is made. The promise will reject if the
    //  promise returned from retryConnection is rejected.
    reschedule: Promise.coroutine(function*(server, addedDelayMs, retryConnection, nick) {
        var q = getQueue(server);

        var promise = q.enqueue(
            `Scheduler.reschedule ${server.domain} ${nick}`,
            {
                fn: retryConnection,
                addedDelayMs: addedDelayMs
            }
        );

        log.info(
            `Queued scheduled promise for ${server.domain} ${nick}` +
            (addedDelayMs > 0 ? ` with ${Math.round(addedDelayMs)}ms added delay`:'')
        );

        return promise;
    }),

    // Reject all queued promises
    killAll: function () {
        let queueKeys = Object.keys(queues);
        for (var i = 0; i < queueKeys.length; i++) {
            var q = queues[queueKeys[i]];
            q.killAll();
        }
    }
};

module.exports = Scheduler;
