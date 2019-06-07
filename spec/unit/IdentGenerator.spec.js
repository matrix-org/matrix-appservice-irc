"use strict";
const Promise = require("bluebird");
const IdentGenerator = require("../../lib/irc/IdentGenerator.js");

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

    it("should attempt to truncate the user ID on a long user ID", function(done) {
        var userId = "@myreallylonguseridhere:localhost";
        var uname = "myreally";
        identGenerator.getIrcNames(ircClientConfig, mkMatrixUser(userId)).done(function(info) {
            expect(info.username).toEqual(uname);
            done();
        });
    });

    it("should start with '_1' on an occupied user ID", function(done) {
        var userId = "@myreallylonguseridhere:localhost";
        var uname = "myreal_1";
        existingUsernames.myreally = "@someone:else";
        identGenerator.getIrcNames(ircClientConfig, mkMatrixUser(userId)).done(function(info) {
            expect(info.username).toEqual(uname);
            done();
        });
    });

    it("should loop from '_9' to '_10' and keep the same total length", function(done) {
        var userId = "@myreallylonguseridhere:localhost";
        var uname = "myrea_10";
        existingUsernames.myreally = "@someone:else";
        for (var i = 1; i < 10; i++) {
            existingUsernames["myreal_" + i] = "@someone:else";
        }
        identGenerator.getIrcNames(ircClientConfig, mkMatrixUser(userId)).done(function(info) {
            expect(info.username).toEqual(uname);
            done();
        });
    });

    it("should loop from '_1' to '_2' and keep the same total length", function(done) {
        var userId = "@myreallylonguseridhere:localhost";
        var uname = "myreal_2";
        existingUsernames = {
            myreally: "@someone:else",
            myreal_1: "@someone:else"
        };
        identGenerator.getIrcNames(ircClientConfig, mkMatrixUser(userId)).done(function(info) {
            expect(info.username).toEqual(uname);
            done();
        });
    });

    it("should eventually give up trying usernames", function(done) {
        IdentGenerator.MAX_USER_NAME_LENGTH = 3;
        storeMock.getMatrixUserByUsername = function() {
            return Promise.resolve({getId: function() { return "@someone:else"} });
        };
        var userId = "@myreallylonguseridhere:localhost";
        identGenerator.getIrcNames(ircClientConfig, mkMatrixUser(userId)).done(function(info) {
            expect(true).toBe(false, "Promise was unexpectedly resolved.");
            done();
        }, function(err) {
            done();
        });
    });

    it("should prefix 'M' onto usernames which don't begin with A-z", function(done) {
        var userId = "@-myname:localhost";
        var uname = "M-myname";
        identGenerator.getIrcNames(ircClientConfig, mkMatrixUser(userId)).done(function(info) {
            expect(info.username).toEqual(uname);
            done();
        });
    });
});
