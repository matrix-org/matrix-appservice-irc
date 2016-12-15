"use strict";

let Promise = require("bluebird");
let QueuePool = require("../../lib/util/QueuePool");
let test = require("../util/test");
let promiseutil = require("../../lib/promiseutil");

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
            console.log("procFn " + item);
            itemToDeferMap[item] = new promiseutil.defer();
            return itemToDeferMap[item].promise;
        })
    });

    xit("should let multiple items be processed at once", function(done) {
        pool.enqueue("a", "a");
        pool.enqueue("b", "b");
        // procFn is called on the next tick so check they've been called after
        process.nextTick(() => {
            expect(Object.keys(itemToDeferMap).length).toBe(2);
            done();
        });
    });

    it("should not let more items than the pool size be processed at once",
    function(done) {
        pool.enqueue("a", "a");
        pool.enqueue("b", "b");
        pool.enqueue("c", "c");
        pool.enqueue("d", "d");
        process.nextTick(() => {
            // first 3 items
            expect(Object.keys(itemToDeferMap).sort()).toEqual(["a","b","c"]);
            if (!itemToDeferMap["b"]) { done(); }
            itemToDeferMap["b"].resolve();
            delete itemToDeferMap["b"];

            setTimeout(() => {
                expect(Object.keys(itemToDeferMap).sort()).toEqual(["a","c","d"]);
                done();
            }, 10);
        });
    });
});
