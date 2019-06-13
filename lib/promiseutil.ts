import * as Bluebird from "bluebird";

export default class PromiseUtil {
    static defer() {
        let resolve
        let reject;
        const promise = new Bluebird(function () {
            resolve = arguments[0];
            reject = arguments[1];
        });
        return {
            resolve: resolve,
            reject: reject,
            promise: promise
        };
    }

    static allSettled(promises) {
        return Bluebird.all(promises.map(function (p) {
            return p.reflect();
        }));
    }

    static delayFor(timeoutMs: number) {
        return Bluebird.delay(timeoutMs);
    }

    static timeoutForPromise(p: Promise<any>, timeoutMs: number) {
        return Bluebird.resolve(p).timeout(timeoutMs);
    }
}