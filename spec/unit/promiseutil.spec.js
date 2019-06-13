"use strict";
const Promise = require("bluebird");
const promiseutil = require("../../lib/promiseutil");

describe("promiseutil.allSettled", function() {
    it("waits for all", function(done) {
        var promises = [
            Promise.resolve("good"),
            Promise.reject(new Error("bad")),

            new Promise(function(resolve, reject) {
                setTimeout(function() {
                    console.log("Waited 50ms");
                    resolve("resolved value");
                }, 50);
            }),

            new Promise(function(resolve, reject) {
                setTimeout(function() {
                    console.log("Waited 60ms");
                    reject(new Error("rejected value"));
                }, 60);
            })
        ];
        promiseutil.allSettled(promises).then(function(settled) {
            expect(settled.length).toEqual(promises.length);

            expect(settled[0].isFulfilled()).toEqual(true);
            expect(settled[0].value()).toEqual("good");

            expect(settled[1].isRejected()).toEqual(true);
            expect(settled[1].reason().message).toEqual("bad");

            expect(settled[2].isFulfilled()).toEqual(true);
            expect(settled[2].value()).toEqual("resolved value");

            expect(settled[3].isRejected()).toEqual(true);
            expect(settled[3].reason().message).toEqual("rejected value");
            done();
        });
    });
});
