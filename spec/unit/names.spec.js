"use strict";
var Promise = require("bluebird");
var proxyquire = require("proxyquire");
var test = require("../util/test");

describe("Username generation", function() {
    var names;
    var storeMock = {
        ircClients: {}
    };
    var existingUsernames = {};
    var ircUser;

    var mkMatrixUser = function(uid) {
        return {
            userId: uid
        };
    };

    beforeEach(function() {
        test.log(this); // eslint-disable-line no-invalid-this
        existingUsernames = {};
        ircUser = {
            nick: "MyCrazyNick",
            server: {
                domain: "somedomain.com"
            }
        };
        storeMock.ircClients.getByUsername = function(domain, uname) {
            var obj;
            if (existingUsernames[uname]) {
                obj = {
                    userId: existingUsernames[uname]
                };
            }
            return Promise.resolve(obj);
        };
        storeMock.ircClients.set = function() {
            return Promise.resolve();
        };

        names = proxyquire("../../lib/irclib/names.js", {
            "../store": storeMock
        });
        names.MAX_USER_NAME_LENGTH = 8;
    });

    it("should attempt a truncated user ID on a long user ID", function(done) {
        var userId = "@myreallylonguseridhere:localhost";
        var uname = "myreally";
        names.getIrcNames(ircUser, mkMatrixUser(userId)).done(function(info) {
            expect(info.username).toEqual(uname);
            done();
        });
    });

    it("should start with '_1' on an occupied user ID", function(done) {
        var userId = "@myreallylonguseridhere:localhost";
        var uname = "myreal_1";
        existingUsernames.myreally = "@someone:else";
        names.getIrcNames(ircUser, mkMatrixUser(userId)).done(function(info) {
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
        names.getIrcNames(ircUser, mkMatrixUser(userId)).done(function(info) {
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
        names.getIrcNames(ircUser, mkMatrixUser(userId)).done(function(info) {
            expect(info.username).toEqual(uname);
            done();
        });
    });

    it("should eventually give up trying usernames", function(done) {
        names.MAX_USER_NAME_LENGTH = 3;
        storeMock.ircClients.getByUsername = function() {
            return Promise.resolve({userId: "@someone:else"});
        };
        var userId = "@myreallylonguseridhere:localhost";
        names.getIrcNames(ircUser, mkMatrixUser(userId)).done(function(info) {
            expect(true).toBe(false, "Promise was unexpectedly resolved.");
            done();
        }, function(err) {
            done();
        });
    });

});
