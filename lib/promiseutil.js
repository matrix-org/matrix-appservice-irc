"use strict";
var Promise = require("bluebird");
function defer() {
    var resolve, reject;
    var promise = new Promise(function () {
        resolve = arguments[0];
        reject = arguments[1];
    });
    return {
        resolve: resolve,
        reject: reject,
        promise: promise
    };
}
function allSettled(promises) {
    return Promise.all(promises.map(function (p) {
        return p.reflect();
    }));
}
module.exports.defer = defer;
module.exports.allSettled = allSettled;
