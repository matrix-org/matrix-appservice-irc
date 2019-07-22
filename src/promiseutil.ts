import {default as Bluebird} from "bluebird";

export function defer() {
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

export function allSettled(promises: Promise<any>[]) {
    return Bluebird.all(promises.map(function (p) {
        return Bluebird.resolve(p).reflect();
    }));
}

export function delayFor(timeoutMs: number) {
    return Bluebird.delay(timeoutMs);
}

export function timeoutForPromise(p: Promise<any>, timeoutMs: number) {
    return Bluebird.resolve(p).timeout(timeoutMs);
}