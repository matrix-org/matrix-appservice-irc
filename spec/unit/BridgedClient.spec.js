"use strict";
const { BridgedClient, BridgedClientStatus } = require("../../lib/irc/BridgedClient.js");

const STATE_DISC = {
    status: BridgedClientStatus.DISCONNECTED
}

const STATE_CONN = {
    status: BridgedClientStatus.CONNECTED,
    client: {}
}

const STATE_CONN_MAX5 = {
    status: BridgedClientStatus.CONNECTED,
    client: {
        supported: {
            nicklength: 5
        }
    }
}

describe("BridgedClient", function() {
    describe("getValidNick", function() {
        it("valid nick unchanged", function() {
            expect(BridgedClient.getValidNick("foobar", true, STATE_DISC)).toBe("foobar");
        });
        it("remove invalid character", function() {
            expect(BridgedClient.getValidNick("f+/\u3052oobar", false, STATE_DISC)).toBe("foobar");
        });
        it("nick must start with letter of special character", function() {
            expect(BridgedClient.getValidNick("foo-bar", false, STATE_DISC)).toBe("foo-bar");
            expect(BridgedClient.getValidNick("[foobar]", false, STATE_DISC)).toBe("[foobar]");
            expect(BridgedClient.getValidNick("{foobar}", false, STATE_DISC)).toBe("{foobar}");
            expect(BridgedClient.getValidNick("-foobar", false, STATE_DISC)).toBe("M-foobar");
            expect(BridgedClient.getValidNick("12345", false, STATE_DISC)).toBe("M12345");
        });
        it("throw if nick invalid", function() {
            expect(() => BridgedClient.getValidNick("f+/\u3052oobar", true, STATE_DISC)).toThrowError();
            expect(() => BridgedClient.getValidNick("a".repeat(20), true, STATE_CONN)).toThrowError();
            expect(() => BridgedClient.getValidNick("-foobar", true, STATE_CONN)).toThrowError();
        });
        it("don't truncate nick if disconnected", function() {
            expect(BridgedClient.getValidNick("a".repeat(20), false, STATE_DISC)).toBe("a".repeat(20));
        });
        it("truncate nick", function() {
            expect(BridgedClient.getValidNick("a".repeat(20), false, STATE_CONN)).toBe("a".repeat(9));
        });
        it("truncate nick with custom max", function() {
            expect(BridgedClient.getValidNick("a".repeat(20), false, STATE_CONN_MAX5)).toBe("a".repeat(5));
        });
    });
});
