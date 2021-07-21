"use strict";
const { trimString } = require("../../lib/util/TrimString.js");

describe("trimString", function() {
    it("should not cut unicode characters in half", (done) => {
        const input = "lol 😅";
        const result = trimString(input, 5);
        expect(result).toEqual(input);

        done();
    });

    it("should trim trailing whitespace by itself", (done) => {
        const input = "lol 😅";
        const result = trimString(input, 4);
        expect(result).toEqual('lol');

        done();
    });
});
