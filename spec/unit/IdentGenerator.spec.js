"use strict";
const Promise = require("bluebird");
const { IdentGenerator } = require("../../lib/irc/IdentGenerator.js");

describe("Username generation", function() {
    var identGenerator;
    var storeMock = {};
    var existingUsernames = {};
    var ircClientConfig;

    var mkMatrixUser = function(uid) {
        return {
            userId: uid,
            getId: function() { return uid; }
        };
    };

    beforeEach(function() {
        existingUsernames = {};
        var _uname;
        ircClientConfig = {
            getDesiredNick: () => { return "MyCrazyNick"; },
            getDomain: () => { return "somedomain.com"; },
            getUsername: () => {
                return _uname;
            },
            getUserId: function() {},
            setUsername: function(u) {
                _uname = u;
            }
        };
        storeMock.getMatrixUserByUsername = function(domain, uname) {
            var obj;
            if (existingUsernames[uname]) {
                obj = {
                    getId: function() { return existingUsernames[uname]; }
                };
            }
            return Promise.resolve(obj);
        };
        storeMock.storeIrcClientConfig = function() {
            return Promise.resolve();
        };
        storeMock.getIrcClientConfig = function() {
            return Promise.resolve();
        };

        identGenerator = new IdentGenerator(storeMock);
        IdentGenerator.MAX_USER_NAME_LENGTH = 8;
    });

    it("should attempt to truncate the user ID on a long user ID", async function() {
        var userId = "@myreallylonguseridhere:localhost";
        var uname = "myreally";
        const info = await identGenerator.getIrcNames(ircClientConfig, mkMatrixUser(userId));
        expect(info.username).toEqual(uname);
    });

    it("should start with '_1' on an occupied user ID", async function() {
        const userId = "@myreallylonguseridhere:localhost";
        const uname = "myreal_1";
        existingUsernames.myreally = "@someone:else";
        const info = await identGenerator.getIrcNames(ircClientConfig, mkMatrixUser(userId));
        expect(info.username).toEqual(uname);
    });

    it("should loop from '_9' to '_10' and keep the same total length", async function() {
        const userId = "@myreallylonguseridhere:localhost";
        const uname = "myrea_10";
        existingUsernames.myreally = "@someone:else";
        for (let i = 1; i < 10; i++) {
            existingUsernames["myreal_" + i] = "@someone:else";
        }
        const info = await identGenerator.getIrcNames(ircClientConfig, mkMatrixUser(userId));
        expect(info.username).toEqual(uname);
    });

    it("should loop from '_1' to '_2' and keep the same total length", async function() {
        const userId = "@myreallylonguseridhere:localhost";
        const uname = "myreal_2";
        existingUsernames = {
            myreally: "@someone:else",
            myreal_1: "@someone:else"
        };
        const info = await identGenerator.getIrcNames(ircClientConfig, mkMatrixUser(userId));
        expect(info.username).toEqual(uname);
    });

    it("should eventually give up trying usernames", async function() {
        IdentGenerator.MAX_USER_NAME_LENGTH = 3;
        storeMock.getMatrixUserByUsername = function() {
            return Promise.resolve({getId: function() { return "@someone:else"} });
        };
        const userId = "@myreallylonguseridhere:localhost";
        try {
            await identGenerator.getIrcNames(ircClientConfig, mkMatrixUser(userId));
        }
        catch (ex) {
            return;
        }
        throw Error("Promise was unexpectedly resolved");
    });

    it("should prefix 'M' onto usernames which don't begin with A-z", async function() {
        const userId = "@-myname:localhost";
        const uname = "M-myname";
        const info = await identGenerator.getIrcNames(ircClientConfig, mkMatrixUser(userId));
        expect(info.username).toEqual(uname);
    });
});
