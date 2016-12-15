"use strict";
let Promise = require("bluebird");
let Queue = require("./Queue");

class QueuePool {

    // Construct a new Queue Pool.
    // This consists of multiple queues. Items will be inserted into
    // the first available free queue. If no queue is free, items will
    // be put in a FIFO overflow queue. You can also use an index when
    // enqueuing to override this.
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
    }

    // Add an item to the queue. ID and item are passed directly to the Queue.
    // Index is optional and should be between 0 - poolSize. It determines
    // which queue to put the item into.
    enqueue(id, item, index) {
        // no index specified: first free queue gets it.
        if (index === undefined) {
            let queue = this._freeQueue();
            if (!queue) {
                // the overflow queue promise is resolved when the item is pushed
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
            return queue.enqueue(id, item);
        }
        if (index >= this.size || index < 0) {
            throw new Error(`enqueue: index ${index} is out of bounds`);
        }
        return this.queues[index].enqueue(id, item);
    }

    // This is called when a request is at the front of the overflow queue.
    _overflow(req) {
        let queue = this._freeQueue();
        if (queue) {
            // cannot return the raw promise else it will be waited on, whereas we want to return
            // the actual promise to the caller of QueuePool.enqueue();
            return Promise.resolve({
                p: queue.enqueue(req.id, req.item)
            });
        }
        // wait for any queue to become available
        let promises = this.queues.map((q) => {
            return q.onceFree();
        });
        return Promise.any(promises).then(() => {
            queue = this._freeQueue();
            if (!queue) {
                throw new Error(`QueuePool overflow: starvation. No free queues.`);
            }
            return {
                p: queue.enqueue(req.id, req.item),
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
