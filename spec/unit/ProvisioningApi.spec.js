"use strict";
const { isValidQueryLinkBody } = require("../../lib/provisioning/Schema.js");

describe("isValidQueryLinkBody", function() {
    const bodyWithKey = (key) => ({
        remote_room_channel: '#test',
        remote_room_server: 'lolcathost',
        key,
    });

    it("should allow clean keys", () => {
        for (const key of [
            '',
            'foo',
            'foo:bar',
            undefined,
        ]) {
            expect(isValidQueryLinkBody(bodyWithKey(key)))
                .withContext(JSON.stringify(key))
                .toEqual(true);
        }
    });

    it("should disallow abusive keys", () => {
        for (const key of [
            'foo\nbar',
            ':foobar',
            'foo bar',
            'foo\x00bar',
        ]) {
            expect(isValidQueryLinkBody(bodyWithKey(key)))
                .withContext(JSON.stringify(key))
                .toEqual(false);
        }
    });
});
