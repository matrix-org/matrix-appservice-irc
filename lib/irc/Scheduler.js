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

var Scheduler = {
    _queueServers: [],
    _queues: {},
    _getQueue: _getQueue,
    _newQueue: _newQueue,
    reschedule: Promise.coroutine(function*(server, addedDelay, retryConnection) {
        var q = Scheduler._getQueue(server);

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

function _newQueue (server) {
    Scheduler._queues[server.domain] = new Queue(procFn, server.getReconnectIntervalMs());
    Scheduler._queueServers.push(server.domain);

    return Scheduler._queues[server.domain];
}

function _getQueue (server) {
    let q = Scheduler._queues[server.domain];

    if (!q) {
        q = Scheduler._newQueue(server);
    }
    return q;
}

// Reject all queued promises
function killAll() {
    for (var i = 0; i < Scheduler._queueServers.length; i++) {
        var q = Scheduler._queues[Scheduler._queueServers[i]];
        q.killAll();
    }
}
module.exports = Scheduler;
