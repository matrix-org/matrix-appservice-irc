"use strict";
let QueuePool = require("../../lib/util/QueuePool");
let promiseutil = require("../../lib/promiseutil");
let test = require("../util/test");

let nextTick = function() {
    return new Promise((resolve, reject) => {
        process.nextTick(() => {
            resolve();
        });
    });
}

describe("QueuePool", function() {
    const size = 3;
    let pool;
    let procFn;
    let itemToDeferMap;

    let resolveItem = function(id, resolveWith) {
        if (!itemToDeferMap[id]) {
            return;
        }
        itemToDeferMap[id].resolve(resolveWith);
        delete itemToDeferMap[id];
    }

    beforeEach(function() {
        procFn = jasmine.createSpy("procFn");
        pool = new QueuePool(size, procFn);
        itemToDeferMap = {
            // $item: Deferred
        };
        procFn.and.callFake((item) => {
            itemToDeferMap[item] = new promiseutil.defer();
            return itemToDeferMap[item].promise;
        });
    });

    it("should let multiple items be processed at once",
    test.coroutine(function*() {
        pool.enqueue("a", "a");
        pool.enqueue("b", "b");
        // procFn is called on the next tick so check they've been called after
        yield nextTick();
        expect(Object.keys(itemToDeferMap).length).toBe(2);
    }));

    it("should resolve enqueued items when they resolve",
    test.coroutine(function*() {
        pool.enqueue("a", "a");
        let promise = pool.enqueue("b", "b");
        yield nextTick();
        resolveItem("b", "stuff");
        let res = yield promise;
        expect(res).toEqual("stuff");
    }));

    it("should not let more items than the pool size be processed at once",
    test.coroutine(function*() {
        pool.enqueue("a", "a");
        pool.enqueue("b", "b");
        pool.enqueue("c", "c");
        pool.enqueue("d", "d");
        yield nextTick();
        expect(Object.keys(itemToDeferMap).sort()).toEqual(["a", "b", "c"]);
        resolveItem("b");
        yield nextTick();
        expect(Object.keys(itemToDeferMap).sort()).toEqual(["a", "c", "d"]);
    }));

    it("should wait until a queue is free", test.coroutine(function*() {
        pool.enqueue("a", "a");
        pool.enqueue("b", "b");
        pool.enqueue("c", "c");
        yield nextTick();
        expect(Object.keys(itemToDeferMap).sort()).toEqual(["a", "b", "c"]);
        yield nextTick();
        yield nextTick();
        pool.enqueue("d", "d");
        // wait a while
        yield nextTick();
        yield nextTick();
        yield nextTick();
        yield nextTick();
        expect(Object.keys(itemToDeferMap).sort()).toEqual(["a", "b", "c"]);
        resolveItem("c");
        yield nextTick();
        expect(Object.keys(itemToDeferMap).sort()).toEqual(["a", "b", "d"]);
    }));

    it("should process overflows FIFO", test.coroutine(function*() {
        pool.enqueue("a", "a");
        pool.enqueue("b", "b");
        pool.enqueue("c", "c");
        pool.enqueue("d", "d");
        pool.enqueue("e", "e");
        yield nextTick();
        expect(Object.keys(itemToDeferMap).sort()).toEqual(["a", "b", "c"]);
        resolveItem("b");
        pool.enqueue("f", "f");
        yield nextTick();
        expect(Object.keys(itemToDeferMap).sort()).toEqual(["a", "c", "d"]);
        resolveItem("a");
        resolveItem("c");
        yield nextTick();
        expect(Object.keys(itemToDeferMap).sort()).toEqual(["d", "e", "f"]);
    }));

    it("should repopulate empty queues", test.coroutine(function*() {
        pool.enqueue("a", "a");
        pool.enqueue("b", "b");
        pool.enqueue("c", "c");
        yield nextTick();
        expect(Object.keys(itemToDeferMap).sort()).toEqual(["a", "b", "c"]);
        resolveItem("a");
        resolveItem("b");
        resolveItem("c");
        yield nextTick();
        expect(Object.keys(itemToDeferMap).sort()).toEqual([]);
        pool.enqueue("d", "d");
        pool.enqueue("e", "e");
        pool.enqueue("f", "f");
        yield nextTick();
        expect(Object.keys(itemToDeferMap).sort()).toEqual(["d", "e", "f"]);
    }));

    it("should allow index-based queue manipulation", test.coroutine(function*() {
        pool.enqueue("a", "a", 0);
        pool.enqueue("b", "b", 0);
        pool.enqueue("c", "c", 0);
        yield nextTick();
        expect(Object.keys(itemToDeferMap).sort()).toEqual(["a"]);
        resolveItem("a");
        yield nextTick();
        expect(Object.keys(itemToDeferMap).sort()).toEqual(["b"]);
    }));

    it("should accurately track waiting items", test.coroutine(function*() {
        for (let i = 0;i<10;i++) {
            pool.enqueue(i, i);
        }
        expect(pool.waitingItems).toEqual(7);
        for (let j = 0; j < 10; j++) {
            yield nextTick();
            resolveItem(j);
        }
        expect(pool.waitingItems).toEqual(0);
    }));
});
