/*eslint no-invalid-this: 0 */
const Promise = require("bluebird");
const promiseutil = require("../promiseutil");

/**
 * Construct a new Queue which will process items FIFO.
 * @param {Function} processFn The function to invoke when the item being processed
 * is in its critical section. Only 1 item at any one time will be calling this function.
 * The function should return a Promise which is resolved/rejected when the next item
 * can be taken from the queue.
 * @param {integer} intervalMs Optional. If provided and > 0, this queue will be serviced
 * at an interval of intervalMs. Otherwise, items will be processed as soon as they become
 * the first item in the queue to be processed.
 */
function Queue(processFn, intervalMs) {
    this._queue = [];
    this._processing = null;
    this._procFn = processFn; // critical section Promise<result> = fn(item)
    this._onceFreeDefers = [];

    if (intervalMs !== undefined && !(Number.isInteger(intervalMs) && intervalMs >= 0) ) {
        throw new Error('intervalMs must be a positive integer');
    }

    this._intervalMs = intervalMs;

    if (this._intervalMs) {
        // Start consuming
        this._consume();
    }
}

/**
 * Return the length of the queue, including the currently processed item.
 * @return {Number} The length of the queue.
 */
Queue.prototype.size = function() {
    return this._queue.length + (this._processing ? 1 : 0);
};

/**
 * Return a promise which is resolved when this queue is free (0 items in queue).
 * @return {Promise<Queue>} Resolves to the Queue itself.
 */
Queue.prototype.onceFree = function() {
    if (this.size() === 0) {
        return Promise.resolve();
    }
    let defer = promiseutil.defer();
    this._onceFreeDefers.push(defer);
    return defer.promise;
};

Queue.prototype._fireOnceFree = function() {
    this._onceFreeDefers.forEach((d) => {
        d.resolve(this);
    });
    this._onceFreeDefers = [];
}

/**
 * Queue up a request for the critical section function.
 * @param {string} id An ID to associate with this request. If there is already a
 * request with this ID, the promise for that request will be returned.
 * @param {*} thing The item to enqueue. It will be passed verbatim to the critical
 * section function passed in the constructor.
 * @return {Promise} A promise which will be resolved/rejected when the queued item
 * has been processed.
 */
Queue.prototype.enqueue = function(id, thing) {
    for (var i = 0; i < this._queue.length; i++) {
        if (this._queue[i].id === id) {
            return this._queue[i].defer.promise;
        }
    }
    let defer = promiseutil.defer();
    this._queue.push({
        id: id,
        item: thing,
        defer: defer
    });
    if (!this._intervalMs) {
        // always process stuff asyncly, never syncly.
        process.nextTick(() => {
            this._consume();
        });
    }
    return defer.promise;
};

Queue.prototype._retry = function () {
    setTimeout(this._consume.bind(this), this._intervalMs);
}

Queue.prototype._consume = Promise.coroutine(function*() {
    if (this._processing) {
        return;
    }
    this._processing = this._queue.shift();
    if (!this._processing) {
        if (this._intervalMs) {
            this._retry();
        }
        this._fireOnceFree();
        return;
    }
    try {
        let thing = this._procFn(this._processing.item);
        let result = yield thing;
        this._processing.defer.resolve(result);
    }
    catch (err) {
        this._processing.defer.reject(err);
    }
    finally {
        this._processing = null;
        if (this._intervalMs) {
            this._retry();
        }
    }
    if (!this._intervalMs) {
        this._consume();
    }
});

Queue.prototype.killAll = function() {
    for (var i = 0; i < this._queue.length; i++) {
        this._queue[i].defer.reject(new Error('Queue killed'));
    }
}


module.exports = Queue;
