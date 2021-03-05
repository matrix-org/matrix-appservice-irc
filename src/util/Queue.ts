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
import * as promiseutil from "../promiseutil";
import { Defer } from "../promiseutil";

export interface QueueItem<T> {
    id: string;
    item: T;
    defer: Defer<unknown>;
}

export type QueueProcessFn<T> = (item: T) => Promise<unknown>|void;

export class Queue<T> {
    private queue: QueueItem<T>[] = [];
    private processing: QueueItem<T>|null|undefined = null;
    private onceFreeDefers: Defer<unknown>[] = [];
    private consume: () => Bluebird<unknown>;

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
    constructor(private processFn: QueueProcessFn<T>, private intervalMs?: number) {
        if (intervalMs !== undefined && !(Number.isInteger(intervalMs) && intervalMs >= 0) ) {
            throw Error('intervalMs must be a positive integer');
        }

        // XXX: Coroutines have subtly different behaviour to async/await functions
        // and I've not managed to track down precisely why. For the sake of keeping the
        // QueuePool tests happy, we will continue to use coroutine functions for now.
        this.consume = Bluebird.coroutine(this.coConsume).bind(this);

        if (intervalMs) {
            // Start consuming
            this.consume();
        }

    }

    /**
     * Return the length of the queue, including the currently processed item.
     * @return {Number} The length of the queue.
     */
    public size(): number {
        return this.queue.length + (this.processing ? 1 : 0);
    }

    /**
     * Return a promise which is resolved when this queue is free (0 items in queue).
     * @return {Promise<Queue>} Resolves to the Queue itself.
     */
    public onceFree(): Promise<unknown> {
        if (this.size() === 0) {
            return Promise.resolve();
        }
        const defer = promiseutil.defer();
        this.onceFreeDefers.push(defer);
        return defer.promise;
    }

    private fireOnceFree() {
        this.onceFreeDefers.forEach((d) => {
            d.resolve(this);
        });
        this.onceFreeDefers = [];
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
    public enqueue(id: string, thing: T) {
        for (let i = 0; i < this.queue.length; i++) {
            if (this.queue[i].id === id) {
                return this.queue[i].defer.promise;
            }
        }
        const defer = promiseutil.defer();
        this.queue.push({
            id: id,
            item: thing,
            defer: defer
        });
        if (!this.intervalMs) {
            // always process stuff asyncly, never syncly.
            process.nextTick(() => {
                this.consume();
            });
        }
        return defer.promise;
    }

    private retry () {
        setTimeout(this.consume.bind(this), this.intervalMs);
    }

    private* coConsume () {
        if (this.processing) {
            return;
        }
        this.processing = this.queue.shift();
        if (!this.processing) {
            if (this.intervalMs) {
                this.retry();
            }
            this.fireOnceFree();
            return;
        }
        try {
            const thing = this.processFn(this.processing.item);
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            const result = yield thing;
            this.processing.defer.resolve(result);
        }
        catch (err) {
            this.processing.defer.reject(err);
        }
        finally {
            this.processing = null;
            if (this.intervalMs) {
                this.retry();
            }
        }
        if (!this.intervalMs) {
            this.consume();
        }
    }

    public killAll() {
        for (let i = 0; i < this.queue.length; i++) {
            this.queue[i].defer.reject(new Error('Queue killed'));
        }
    }
}
