"use strict";
const IrcServer = require("../../lib/irc/IrcServer");
const extend = require("extend");
describe("IrcServer", function() {
    describe("getNick", function() {
        it("should get a nick from a userid", function() {
            const server = new IrcServer("irc.foobar",
                extend(true, IrcServer.DEFAULT_CONFIG, {})
            );
            expect(server.getNick("@foobar:foobar")).toBe("M-foobar");
        });
        it("should get a nick from a displayname", function() {
            const server = new IrcServer("irc.foobar",
                extend(true, IrcServer.DEFAULT_CONFIG, {})
            );
            expect(server.getNick("@foobar:foobar", "wiggle")).toBe("M-wiggle");
        });
        it("should get a reduced nick if the displayname contains some invalid chars", function() {
            const server = new IrcServer("irc.foobar",
                extend(true, IrcServer.DEFAULT_CONFIG, {})
            );
            expect(server.getNick("@foobar:foobar", "💩wiggleケ")).toBe("M-wiggle");
        });
        it("should use userid if the displayname is all invalid chars", function() {
            const server = new IrcServer("irc.foobar",
                extend(true, IrcServer.DEFAULT_CONFIG, {})
            );
            expect(server.getNick("@foobar:foobar", "💩ケ")).toBe("M-foobar");
        });
    });
});
