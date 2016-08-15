/*eslint no-invalid-this: 0*/
"use strict"
var promiseutil = require("../promiseutil");
var Promise = require("bluebird");
var logging = require("../logging");
var log = logging.get("scheduler");

/**
 * An IRC connection scheduler. Enables ConnectionInstance to reconnect
 * in a way that queues reconnection requests and services the FIFO queue at a
 * rate determined by ircServer.getReconnectInterval().
 */

var Scheduler = {
    _queueServers: [],
    _queues: {},
    _processing : {},
    _getQueue: _getQueue,
    _newQueue: _newQueue,
    _procFn: _procFn,
    reschedule: Promise.coroutine(function*(server, addedDelay, retryConnection) {
        var d = promiseutil.defer();

        var q = Scheduler._getQueue(server);

        log.info(
            `Queued new scheduled promise for ${server.domain}` +
            (addedDelay > 0 ? ` with ${Math.round(addedDelay)}ms added delay`:'')
        );
        yield Promise.delay(addedDelay);

        q.push({defer: d, fn: retryConnection});

        return d.promise;
    }),
    killAll: killAll
};

function _procFn (item) {
    return item.fn();
}

function _newQueue (server) {
    Scheduler._queues[server.domain] = [];
    Scheduler._queueServers.push(server.domain);

    let handleQueue = Promise.coroutine(function*() {
        if (Scheduler._processing[server.domain]) {
            return;
        }
        Scheduler._processing[server.domain] = Scheduler._queues[server.domain].shift();
        if (!Scheduler._processing[server.domain]) {
            return;
        }
        try {
            let thing = Scheduler._procFn(Scheduler._processing[server.domain]);

            let result = yield thing;
            log.info(`Resolving scheduled promise for ${server.domain}`);
            Scheduler._processing[server.domain].defer.resolve(result);
        }
        catch (err) {
            log.info(`Rejecting scheduled promise for ${server.domain}`);
            Scheduler._processing[server.domain].defer.reject(err);
        }
        finally {
            Scheduler._processing[server.domain] = null;
        }
    });

    setInterval(handleQueue, server.getReconnectInterval());

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
        for (var j = 0; j < q.length; j++) {
            q[j].reject();
        }
    }
}
module.exports = Scheduler;
