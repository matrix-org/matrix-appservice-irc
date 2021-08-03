"use strict";
const { renderTemplate } = require("../../lib/util/Template.js");

describe("renderTemplate", function() {
    it("should replace placeholders with submitted values", () => {
        const template = '$FOO bar $BAZ';
        const result = renderTemplate(template, {
            foo: 'one',
            baz: 'two',
        });
        expect(result).toEqual('one bar two');
    });
});
