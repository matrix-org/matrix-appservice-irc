const { QueuePool } = require("../../lib/util/QueuePool");
const promiseutil = require("../../lib/promiseutil");

async function nextTick(ticks = 1) {
    while (ticks > 0) {
        await new Promise(resolve => process.nextTick(resolve));
        ticks--;
    }
    return undefined;
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
    async () => {
        pool.enqueue("a", "a");
        pool.enqueue("b", "b");
        // procFn is called on the next tick so check they've been called after
        await nextTick();
        expect(Object.keys(itemToDeferMap).length).toBe(2);
    });

    it("should resolve enqueued items when they resolve",
    async () => {
        pool.enqueue("a", "a");
        const promise = pool.enqueue("b", "b");
        await nextTick();
        resolveItem("b", "stuff");
        let res = await promise;
        expect(res).toEqual("stuff");
    });

    it("should not let more items than the pool size be processed at once", async () => {
        pool.enqueue("a", "a");
        const b = pool.enqueue("b", "b");
        pool.enqueue("c", "c");
        pool.enqueue("d", "d");
        await nextTick();
        expect(Object.keys(itemToDeferMap).sort()).toEqual(["a", "b", "c"]);
        resolveItem("b");
        // wait for b to complete, so that the queue empies up and accepts "d"
        await b;
        expect(Object.keys(itemToDeferMap).sort()).toEqual(["a", "c", "d"]);
    });

    it("should wait until a queue is free", async () => {
        pool.enqueue("a", "a");
        pool.enqueue("b", "b");
        const c = pool.enqueue("c", "c");
        await nextTick();
        expect(Object.keys(itemToDeferMap).sort()).toEqual(["a", "b", "c"]);
        await nextTick(2);
        pool.enqueue("d", "d");
        // wait a while
        await nextTick(4);
        expect(Object.keys(itemToDeferMap).sort()).toEqual(["a", "b", "c"]);
        resolveItem("c");
        // wait for c to complete, so that the queue empies up and accepts "d"
        await c;
        await nextTick();
        expect(Object.keys(itemToDeferMap).sort()).toEqual(["a", "b", "d"]);
    });

    it("should process overflows FIFO", async () => {
        const a = pool.enqueue("a", "a");
        const b = pool.enqueue("b", "b");
        const c = pool.enqueue("c", "c");
        pool.enqueue("d", "d");
        pool.enqueue("e", "e");
        await nextTick();
        expect(Object.keys(itemToDeferMap).sort()).toEqual(["a", "b", "c"]);
        resolveItem("b");
        await b;
        pool.enqueue("f", "f");
        await nextTick();
        expect(Object.keys(itemToDeferMap).sort()).toEqual(["a", "c", "d"]);
        resolveItem("a");
        await a;
        resolveItem("c");
        await c;
        await nextTick();
        expect(Object.keys(itemToDeferMap).sort()).toEqual(["d", "e", "f"]);
    });

    it("should repopulate empty queues", async () => {
        const a = pool.enqueue("a", "a");
        const b = pool.enqueue("b", "b");
        const c = pool.enqueue("c", "c");
        await nextTick();
        expect(Object.keys(itemToDeferMap).sort()).toEqual(["a", "b", "c"]);
        resolveItem("a");
        await a;
        resolveItem("b");
        await b;
        resolveItem("c");
        await c;
        await nextTick();
        expect(Object.keys(itemToDeferMap).sort()).toEqual([]);
        pool.enqueue("d", "d");
        pool.enqueue("e", "e");
        pool.enqueue("f", "f");
        await nextTick();
        expect(Object.keys(itemToDeferMap).sort()).toEqual(["d", "e", "f"]);
    });

    it("should allow index-based queue manipulation", async () => {
        const a = pool.enqueue("a", "a", 0);
        pool.enqueue("b", "b", 0);
        pool.enqueue("c", "c", 0);
        await nextTick();
        expect(Object.keys(itemToDeferMap).sort()).toEqual(["a"]);
        resolveItem("a");
        await a;
        await nextTick();
        expect(Object.keys(itemToDeferMap).sort()).toEqual(["b"]);
    });

    it("should accurately track waiting items", async () => {
        const promises = [];
        for (let i = 0; i < 10; i++) {
            promises[i] = pool.enqueue(i, i);
        }
        expect(pool.waitingItems).toEqual(7);
        for (let j = 0; j < 10; j++) {
            await nextTick();
            resolveItem(j);
            await promises[j];
        }
        expect(pool.waitingItems).toEqual(0);
    });
});
