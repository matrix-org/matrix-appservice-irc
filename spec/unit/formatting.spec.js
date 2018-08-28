"use strict";
const formatting = require("../../lib/irc/formatting.js");

describe("Formatting", function() {
    describe("htmlToIrc", function() {
        it("should have non-formatted for non-html inputs", function() {
            expect(
                formatting.htmlToIrc("The quick brown fox jumps over the lazy dog.")
            ).toBe("The quick brown fox jumps over the lazy dog.");
        });
        it("should bold formatting for <b> inputs", function() {
            expect(
                formatting.htmlToIrc("The quick brown <b>fox</b> jumps over the lazy <b>dog</b>.")
            ).toBe("The quick brown \u0002fox\u000f jumps over the lazy \u0002dog\u000f.");
        });
        it("should have regular characters for inputs containing non-safe html chars", function() {
            expect(
                formatting.htmlToIrc("%100 of \"homes\" should have <u>dogs</u>. Facts © Half-Shot")
            ).toBe("%100 of \"homes\" should have \u001fdogs\u000f. Facts © Half-Shot");
        });
        it("should colourise many text", function() {
            expect(
                formatting.htmlToIrc(`<font color="red">R</font><font color="orange">a</font>`+
                                     `<font color="yellow">i</font><font color="green">n</font>`+
                                     `<font color="blue">b</font><font color="purple">o</font>`+
                                     `<font color="fuchsia">w</font>`)
            ).toBe("\u000304R\u000f" +
                   "\u000307a\u000f" +
                   "\u000308i\u000f" +
                   "\u000303n\u000f" +
                   "\u000312b\u000f" +
                   "\u000306o\u000f" +
                   "\u000313w\u000f");
        });
        it("should be null for unsupported tags", function() {
            expect(
                formatting.htmlToIrc("The quick brown <iframe>fox</iframe> jumps over the lazy <b>dog</b>.")
            ).toBe(null);
        });
    });
});