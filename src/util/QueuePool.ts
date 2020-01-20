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
import Promise from "bluebird";
import { Queue, QueueProcessFn } from "./Queue";

/**
 * A Queue Pool is a queue which is backed by a pool of queues which can be serviced
 * concurrently. The number of items which can be processed concurrently is the size
 * of the queue. The QueuePool always operates in a FIFO manner, even when all queues
 * are occupied.
**/
export class QueuePool<T> {
    private queues: Queue<T>[] = [];
    private overflow: Queue<{id: string; item: T}>;

    /**
     * Construct a new Queue Pool.
     * This consists of multiple queues. Items will be inserted into
     * the first available free queue. If no queue is free, items will
     * be put in a FIFO overflow queue. You can also use an index when
     * enqueuing to override this behaviour.
    */
    constructor(private size: number, fn: QueueProcessFn<T>) {
        if (size < 1) {
            throw new Error("Pool size must be at least 1");
        }
        for (let i = 0; i < size; i++) {
            this.queues.push(new Queue(fn));
        }
        this.overflow = new Queue((item) => {
            return this.onOverflow(item);
        });
    }

    /**
     * Get number of items waiting to be inserted into a queue.
     */
    get waitingItems() {
        return this.overflow.size();
    }

    /**
     * Add an item to the queue. ID and item are passed directly to the Queue.
     * Index is optional and should be between 0 ~ poolSize-1. It determines
     * which queue to put the item into, which will bypass the overflow queue.
     * Returns: A promise which resolves when the item has been serviced, and
     *          the promise returned by the queue function has resolved.
    */
    public enqueue(id: string, item: T, index?: number) {
        if (index !== undefined) {
            if (index >= this.size || index < 0) {
                throw new Error(`enqueue: index ${index} is out of bounds`);
            }
            return this.queues[index].enqueue(id, item);
        }

        // no index specified: first free queue gets it.
        const queue = this.freeQueue();
        if (queue) {
            // push it to the queue pool immediately.
            return queue.enqueue(id, item);
        }
        // All the queues are busy.
        // The overflow queue promise is resolved when the item is pushed
        // onto the queue pool. We want to return a promise which resolves
        // after the item has finished executing on the queue pool, hence
        // the promise chain here.
        return this.overflow.enqueue(id, {
            id,
            item,
        }).then((req) => {
            return (req as {p: Promise<unknown>}).p;
        });
    }

    // This is called when a request is at the front of the overflow queue.
    private onOverflow(req: {id: string; item: T}) {
        const queue = this.freeQueue();
        if (queue) {
            // cannot return the raw promise else it will be waited on, whereas we want to return
            // the actual promise to the caller of QueuePool.enqueue(); so wrap it up in an object.
            return Promise.resolve({
                p: queue.enqueue(req.id, req.item)
            });
        }
        // wait for any queue to become available
        const promises = this.queues.map((q) => {
            return q.onceFree().then(() => q);
        });
        return Promise.any(promises).then((q) => {
            if ((q as Queue<T>).size() !== 0) {
                throw new Error(`QueuePool overflow: starvation. No free queues.`);
            }
            return {
                p: q.enqueue(req.id, req.item),
            };
        })
    }

    private freeQueue() {
        for (let i = 0; i < this.queues.length; i++) {
            if (this.queues[i].size() === 0) {
                return this.queues[i];
            }
        }
        return null;
    }

}
