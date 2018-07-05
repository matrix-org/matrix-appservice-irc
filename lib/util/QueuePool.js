"use strict";
let Promise = require("bluebird");
let Queue = require("./Queue");

// A Queue Pool is a queue which is backed by a pool of queues which can be serviced
// concurrently. The number of items which can be processed concurrently is the size
// of the queue. The QueuePool always operates in a FIFO manner, even when all queues
// are occupied.
class QueuePool {

    // Construct a new Queue Pool.
    // This consists of multiple queues. Items will be inserted into
    // the first available free queue. If no queue is free, items will
    // be put in a FIFO overflow queue. You can also use an index when
    // enqueuing to override this behaviour.
    constructor(poolSize, fn) {
        if (poolSize < 1) {
            throw new Error("Pool size must be at least 1");
        }
        this.size = poolSize;
        this.fn = fn;
        this.queues = [];
        for (let i = 0; i < poolSize; i++) {
            this.queues.push(new Queue(fn));
        }
        this.overflow = new Queue(this._overflow.bind(this));
        this._overflowCount = 0;
    }

    // Get number of items waiting to be inserted into a queue.
    get waitingItems() { return this._overflowCount; }

    // Add an item to the queue. ID and item are passed directly to the Queue.
    // Index is optional and should be between 0 ~ poolSize-1. It determines
    // which queue to put the item into, which will bypass the overflow queue.
    // Returns: A promise which resolves when the item has been serviced, and
    //          the promise returned by the queue function has resolved.
    enqueue(id, item, index) {
        if (index !== undefined) {
            if (index >= this.size || index < 0) {
                throw new Error(`enqueue: index ${index} is out of bounds`);
            }
            return this.queues[index].enqueue(id, item);
        }

        // no index specified: first free queue gets it.
        let queue = this._freeQueue();
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
            id: id,
            item: item,
        }).then((req) => {
            return req.p;
        });
    }

    // This is called when a request is at the front of the overflow queue.
    _overflow(req) {
        let queue = this._freeQueue();
        if (queue) {
            // cannot return the raw promise else it will be waited on, whereas we want to return
            // the actual promise to the caller of QueuePool.enqueue(); so wrap it up in an object.
            return Promise.resolve({
                p: queue.enqueue(req.id, req.item)
            });
        }
        this._overflowCount++;
        // wait for any queue to become available
        let promises = this.queues.map((q) => {
            return q.onceFree();
        });
        return Promise.any(promises).then((q) => {
            this._overflowCount--;
            if (q.size() !== 0) {
                throw new Error(`QueuePool overflow: starvation. No free queues.`);
            }
            return {
                p: q.enqueue(req.id, req.item),
            };
        })
    }

    _freeQueue() {
        for (let i = 0; i < this.queues.length; i++) {
            if (this.queues[i].size() === 0) {
                return this.queues[i];
            }
        }
        return null;
    }

}

module.exports = QueuePool;
