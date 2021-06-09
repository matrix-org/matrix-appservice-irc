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
                formatting.htmlToIrc("The quick brown <iframe>fox</iframe>"+
                                     "jumps over the lazy <b>dog</b>.")
            ).toBe(null);
        });
    });
    describe("ircToHtml", function() {
        it("should have non-HTML for non-formatted inputs", function() {
            expect(
                formatting.ircToHtml("The quick brown fox jumps over the lazy dog.")
            ).toBe("The quick brown fox jumps over the lazy dog.");
        });
        it("should <b> for bold inputs", function() {
            expect(
                formatting.ircToHtml("The quick brown \u0002fox\u000f jumps over the lazy \u0002dog\u000f.")
            ).toBe("The quick brown <b>fox</b> jumps over the lazy <b>dog</b>.");
        });
    });
    describe("stripIrcFormatting", function() {
        it("should not strip ZWSP characters", () => {
            const text = "Lorem\u200bIpsum\u200bDolor\u200bSit";
            expect(formatting.stripIrcFormatting(text)).withContext("ZWSPs missing").toBe(text);
        });
    });
    describe("markdownCodeToIrc", function() {
        it("should return null for a non-code input", function() {
            expect(
                formatting.markdownCodeToIrc("The quick brown fox jumps over the lazy dog.")
            ).toBe(null);
        });
        it("should remove markdown code delimiters", function() {
            expect(
                formatting.markdownCodeToIrc("```\nconst matrixBridge = true;\n```")
            ).toBe("const matrixBridge = true;");
        });
        it("should trim whitespaces around the markdown code delimiters", function () {
            expect(
                formatting.markdownCodeToIrc(" \t\n```\nconst matrixBridge = true;\n```\n ")
            ).toBe("const matrixBridge = true;");
        });
        it("should support multiple lines", function () {
            expect(
                formatting.markdownCodeToIrc("```\n'use strict';\nconst matrixBridge = true;\nparty();\n```")
            ).toBe("'use strict';\nconst matrixBridge = true;\nparty();");
        });
        it("should remove language annotation in the after the intro delimiter", function () {
            expect(
                formatting.markdownCodeToIrc("```js\nconst matrixBridge = true;\n```")
            ).toBe("const matrixBridge = true;");
        });
    });
});
