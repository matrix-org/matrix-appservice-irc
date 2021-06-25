"use strict";
const Promise = require("bluebird");
const { Queue } = require("../../lib/util/Queue.js");
const test = require("../util/test");

describe("Queue", function() {
    let queue;
    let procFn;

    beforeEach(function() {
        procFn = jasmine.createSpy("procFn");
        queue = new Queue(procFn);
    });

    it("should process requests FIFO", (done) => {
        const thing1 = { foo: "bar"};
        const thing2 = { bar: "baz"};
        const things = [thing1, thing2];
        procFn.and.callFake((thing) => {
            expect(thing).toBeDefined();
            expect(things.shift()).toEqual(thing);
            if (things.length === 0) {
                done();
            }
            return Promise.resolve();
        });
        queue.enqueue("id1", thing1);
        queue.enqueue("id2", thing2);
    });

    it("should pass the item given in enqueue() to procFn", (done) => {
        const theThing = { foo: "buzz" };
        procFn.and.callFake((thing) => {
            expect(thing).toBeDefined();
            expect(thing).toEqual(theThing);
            done();
            return Promise.resolve();
        });
        queue.enqueue("id", theThing);
    });

    it("should return a Promise from enqueue() which is resolved with the result from procFn",
        (done) => {
            const theThing = { foo: "buzz" };
            const thePromise = Promise.resolve("flibble");
            procFn.and.callFake((thing) => {
                expect(thing).toBeDefined();
                expect(thing).toEqual(theThing);
                return thePromise;
            });
            queue.enqueue("id", theThing).then((res) => {
                expect(res).toEqual("flibble");
                done();
            });
        }
    );

    it("should return a Promise from enqueue() which is rejected if procFn rejects",
        test.coroutine(function*(done) {
            const theThing = { foo: "buzz" };
            const thePromise = Promise.reject(new Error("oh no"));
            thePromise.catch(() => {}); // stop bluebird whining
            procFn.and.callFake((thing) => {
                expect(thing).toBeDefined();
                expect(thing).toEqual(theThing);
                return thePromise;
            });
            try {
                yield queue.enqueue("id", theThing);
                expect(true).withContext("Enqueued promise resolved: expected rejected").toBe(false);
            }
            catch (err) {
                expect(err.message).toEqual("oh no");
            }
        })
    );

    it("should only ever have 1 procFn in-flight at any one time", (done) => {
        let callCount = 0;
        let resolve;
        const thePromise = new Promise((resolveFn) => {
            resolve = resolveFn;
        });
        procFn.and.callFake(() => {
            callCount += 1;
            return thePromise;
        });
        queue.enqueue("id", { foo: "buzz" });
        queue.enqueue("id2", { bar: "bizz" });
        Promise.delay(50).then(() => {
            expect(callCount).toEqual(1);
            resolve();
            return Promise.delay(10);
        }).then(() => {
            expect(callCount).toEqual(2);
            done();
        });
    });

    it("should return the same promise for requests with the same ID", (done) => {
        const theThing = { foo: "buzz" };
        const thePromise = Promise.resolve("flibble");
        let callCount = 0;
        procFn.and.callFake((thing) => {
            expect(thing).toBeDefined();
            expect(thing).toEqual(theThing);
            callCount += 1;
            return thePromise;
        });
        const promise1 = queue.enqueue("id", theThing);
        const promise2 = queue.enqueue("id", theThing);
        expect(promise1).toEqual(promise2);
        promise1.then((res) => {
            expect(promise2.isPending()).toBe(false);
            expect(res).toEqual("flibble");
            expect(callCount).toEqual(1);
            done();
        });
    });

    it("should have the correct size", (done) => {
        const thing1 = { foo: "bar"};
        const thing2 = { bar: "baz"};
        const things = [thing1, thing2];
        let expectedSize = things.length;
        procFn.and.callFake(() => {
            things.shift();
            expect(queue.size()).toEqual(expectedSize);
            if (things.length === 0) {
                done();
            }
            expectedSize--;
            return Promise.resolve();
        });
        expect(queue.size()).toEqual(0);
        queue.enqueue("id1", thing1);
        expect(queue.size()).toEqual(1);
        queue.enqueue("id2", thing2);
        expect(queue.size()).toEqual(2);
    });
});
