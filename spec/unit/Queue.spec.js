"use strict";
var Promise = require("bluebird");
var Queue = require("../../lib/util/Queue.js");

describe("Queue", function() {
    var queue;
    var procFn;

    beforeEach(function() {
        procFn = jasmine.createSpy("procFn");
        queue = new Queue(procFn);
    });

    it("should process requests FIFO", (done) => {
        var thing1 = { foo: "bar"};
        var thing2 = { bar: "baz"};
        var things = [thing1, thing2];
        procFn.andCallFake((thing) => {
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
        var theThing = { foo: "buzz" };
        procFn.andCallFake((thing) => {
            expect(thing).toBeDefined();
            expect(thing).toEqual(theThing);
            done();
            return Promise.resolve();
        });
        queue.enqueue("id", theThing);
    });

    it("should return a Promise from enqueue() which is resolved with the result from procFn",
    (done) => {
        var theThing = { foo: "buzz" };
        var thePromise = Promise.resolve("flibble");
        procFn.andCallFake((thing) => {
            expect(thing).toBeDefined();
            expect(thing).toEqual(theThing);
            return thePromise;
        });
        queue.enqueue("id", theThing).done((res) => {
            expect(res).toEqual("flibble");
            done();
        });
    });

    it("should return a Promise from enqueue() which is rejected if procFn rejects", (done) => {
        var theThing = { foo: "buzz" };
        var thePromise = Promise.reject(new Error("oh no"));
        procFn.andCallFake((thing) => {
            expect(thing).toBeDefined();
            expect(thing).toEqual(theThing);
            return thePromise;
        });
        queue.enqueue("id", theThing).catch((res) => {
            expect(res.message).toEqual("oh no");
            done();
        });
    });

    it("should only ever have 1 procFn in-flight at any one time", (done) => {
        var callCount = 0;
        var resolve;
        var thePromise = new Promise((resolveFn, rejectFn) => {
            resolve = resolveFn;
        });
        procFn.andCallFake((thing) => {
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
        var theThing = { foo: "buzz" };
        var thePromise = Promise.resolve("flibble");
        var callCount = 0;
        procFn.andCallFake((thing) => {
            expect(thing).toBeDefined();
            expect(thing).toEqual(theThing);
            callCount += 1;
            return thePromise;
        });
        var promise1 = queue.enqueue("id", theThing);
        var promise2 = queue.enqueue("id", theThing);
        expect(promise1).toEqual(promise2);
        promise1.done((res) => {
            expect(promise2.isPending()).toBe(false);
            expect(res).toEqual("flibble");
            expect(callCount).toEqual(1);
            done();
        });
    });
});
