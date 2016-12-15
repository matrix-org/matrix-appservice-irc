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

    beforeEach(function() {
        procFn = jasmine.createSpy("procFn");
        pool = new QueuePool(size, procFn);
        itemToDeferMap = {
            // $item: Deferred
        };
        procFn.andCallFake((item) => {
            itemToDeferMap[item] = new promiseutil.defer();
            return itemToDeferMap[item].promise;
        })
    });

    it("should let multiple items be processed at once",
    test.coroutine(function*() {
        pool.enqueue("a", "a");
        pool.enqueue("b", "b");
        // procFn is called on the next tick so check they've been called after
        yield nextTick();
        expect(Object.keys(itemToDeferMap).length).toBe(2);
    }));

    it("should not let more items than the pool size be processed at once",
    test.coroutine(function*() {
        pool.enqueue("a", "a");
        pool.enqueue("b", "b");
        pool.enqueue("c", "c");
        pool.enqueue("d", "d");
        yield nextTick();
        expect(Object.keys(itemToDeferMap).sort()).toEqual(["a", "b", "c"]);
        if (!itemToDeferMap["b"]) {
            return; // already failed
        }
        itemToDeferMap["b"].resolve();
        delete itemToDeferMap["b"];
        yield nextTick();
        expect(Object.keys(itemToDeferMap).sort()).toEqual(["a", "c", "d"]);
    }));
});
