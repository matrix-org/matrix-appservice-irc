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

 var _queues = {};

function _newQueue (server) {
    _queues[server.domain] = new Queue(procFn, server.getReconnectIntervalMs());

    return _queues[server.domain];
}

function _getQueue (server) {
    let q = _queues[server.domain];

    if (!q) {
        q = _newQueue(server);
    }
    return q;
}

var Scheduler = {
    reschedule: Promise.coroutine(function*(server, addedDelay, retryConnection) {
        var q = _getQueue(server);

        var promise = q.enqueue(
            `Scheduler.reschedule ${server.domain}`,
            {
                fn: retryConnection,
                addedDelay: addedDelay
            }
        );

        log.info(
            `Queued new scheduled promise for ${server.domain}` +
            (addedDelay > 0 ? ` with ${Math.round(addedDelay)}ms added delay`:'')
        );

        return promise;
    }),
    killAll: killAll
};

function procFn (item) {
    return Promise.delay(item.addedDelay).then(item.fn);
}


// Reject all queued promises
function killAll() {
    let queueKeys = Object.keys(_queues);
    for (var i = 0; i < queueKeys.length; i++) {
        var q = _queues[queueKeys[i]];
        q.killAll();
    }
}
module.exports = Scheduler;
