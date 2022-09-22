/*
Copyright 2019 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import Bluebird from "bluebird";
import { getLogger } from "../logging";
import { delay } from "../promiseutil";
import { Queue } from "../util/Queue";
import { IrcServer } from "./IrcServer";

const log = getLogger("scheduler");

interface QueueItem {
    fn: () => Promise<unknown>;
    addedDelayMs: number;
}

// Maps domain => Queue
const queues: {[domain: string]: Queue<QueueItem>} = {};

function getQueue (server: IrcServer) {
    let q = queues[server.domain];

    if (!q) {
        q = new Queue((item) => {
            return delay(item.addedDelayMs).then(item.fn);
        }, server.getReconnectIntervalMs());
        queues[server.domain] = q;
    }
    return q;
}

/**
 * An IRC connection scheduler. Enables ConnectionInstance to reconnect
 * in a way that queues reconnection requests and services the FIFO queue at a
 * rate determined by ircServer.getReconnectIntervalMs().
 */
export default {
    // Returns a promise that will be resolved when retryConnection returns a promise that
    //  resolves, in other words, when the connection is made. The promise will reject if the
    //  promise returned from retryConnection is rejected.
    // eslint-disable-next-line require-yield
    reschedule: Bluebird.coroutine(function*(
        server: IrcServer,
        addedDelayMs: number,
        retryConnection: () => Promise<unknown>,
        nick: string) {
        const q = getQueue(server);

        const promise = q.enqueue(
            `Scheduler.reschedule ${server.domain} ${nick}`,
            {
                fn: retryConnection,
                addedDelayMs: addedDelayMs
            } as QueueItem
        );

        log.debug(
            `Queued scheduled promise for ${server.domain} ${nick}` +
            (addedDelayMs > 0 ? ` with ${Math.round(addedDelayMs)}ms added delay`:'')
        );

        log.debug(
            `Queue for ${server.domain} length = ${q.size()}`
        );

        return promise;
    }),

    // Reject all queued promises
    killAll: function () {
        const queueKeys = Object.keys(queues);
        for (let i = 0; i < queueKeys.length; i++) {
            const q = queues[queueKeys[i]];
            q.killAll();
        }
    }
}
