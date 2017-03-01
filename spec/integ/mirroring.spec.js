"use strict";
var Promise = require("bluebird");
var test = require("../util/test");

// set up integration testing mocks
var env = test.mkEnv();

// set up test config
var config = env.config;
var roomMapping = {
    server: config._server,
    botNick: config._botnick,
    channel: config._chan,
    roomId: config._roomid
};

// set up config.yaml flags
config.ircService.servers[roomMapping.server].membershipLists.enabled = true;
config.ircService.servers[
    roomMapping.server
].membershipLists.global.ircToMatrix.incremental = true;
config.ircService.servers[
    roomMapping.server
].membershipLists.global.matrixToIrc.incremental = true;

// add additional mappings
config.ircService.servers[roomMapping.server].mappings["#a"] = ["!a:localhost"];
config.ircService.servers[roomMapping.server].mappings["#b"] = ["!b:localhost"];
config.ircService.servers[roomMapping.server].mappings["#c"] = ["!c:localhost"];

describe("Mirroring", function() {
    var testUser = {
        id: "@flibble:wibble",
        nick: "M-flibble"
    };

    beforeEach(test.coroutine(function*() {
        yield test.beforeEach(env);

        // accept connection requests
        env.ircMock._autoConnectNetworks(
            roomMapping.server, testUser.nick, roomMapping.server
        );
        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );
        env.ircMock._autoJoinChannels(
            roomMapping.server, roomMapping.botNick, roomMapping.channel
        );

        // do the init
        yield test.initEnv(env);
    }));

    afterEach(test.coroutine(function*() {
        yield test.afterEach(env);
    }));

    describe("Matrix users on IRC", function() {
        it("should join the IRC channel when the Matrix user joins", function(done) {
            var joined = false;
            env.ircMock._whenClient(roomMapping.server, testUser.nick, "join",
            function(client, channel, cb) {
                expect(client.nick).toEqual(testUser.nick);
                expect(client.addr).toEqual(roomMapping.server);
                expect(channel).toEqual(roomMapping.channel);
                joined = true;
                client._invokeCallback(cb);
            });

            env.mockAppService._trigger("type:m.room.member", {
                content: {
                    membership: "join"
                },
                user_id: testUser.id,
                state_key: testUser.id,
                room_id: roomMapping.roomId,
                type: "m.room.member"
            }).done(function() {
                expect(joined).toBe(true, "Didn't join");
                done();
            });
        });

        it("should part the IRC channel when the Matrix user leaves", function(done) {
            var parted = false;
            env.ircMock._autoJoinChannels(
                roomMapping.server, testUser.nick, roomMapping.channel
            );
            env.ircMock._whenClient(roomMapping.server, testUser.nick, "part",
            function(client, channel, msg, cb) {
                expect(client.nick).toEqual(testUser.nick);
                expect(client.addr).toEqual(roomMapping.server);
                expect(channel).toEqual(roomMapping.channel);
                parted = true;
                client._invokeCallback(cb);
            });

            env.mockAppService._trigger("type:m.room.message", {
                content: {
                    body: "dummy text to get it to join",
                    msgtype: "m.text"
                },
                user_id: testUser.id,
                room_id: roomMapping.roomId,
                type: "m.room.message"
            }).then(function() {
                return env.mockAppService._trigger("type:m.room.member", {
                    content: {
                        membership: "leave"
                    },
                    user_id: testUser.id,
                    state_key: testUser.id,
                    room_id: roomMapping.roomId,
                    type: "m.room.member"
                });
            }).done(function() {
                expect(parted).toBe(true, "Didn't part");
                done();
            });
        });

        it("should no-op if a Matrix user joins a room not being tracked",
        function(done) {
            env.ircMock._whenClient(roomMapping.server, testUser.nick, "join",
            function(client, channel, cb) {
                expect(false).toBe(true, "IRC client joined but shouldn't have.");
            });
            env.ircMock._whenClient(roomMapping.server, testUser.nick, "part",
            function(client, channel, cb) {
                expect(false).toBe(true, "IRC client parted but shouldn't have.");
            });

            env.mockAppService._trigger("type:m.room.member", {
                content: {
                    membership: "join"
                },
                user_id: testUser.id,
                state_key: testUser.id,
                room_id: "!bogusroom:id",
                type: "m.room.member"
            }).done(function() {
                done();
            });
        });

        it("should no-op if a Matrix user leaves a room and they aren't " +
        "connected to the IRC channel", function(done) {
            env.ircMock._whenClient(roomMapping.server, testUser.nick, "join",
            function(client, channel, cb) {
                expect(false).toBe(true, "IRC client joined but shouldn't have.");
            });
            env.ircMock._whenClient(roomMapping.server, testUser.nick, "part",
            function(client, channel, cb) {
                expect(false).toBe(true, "IRC client parted but shouldn't have.");
            });

            env.mockAppService._trigger("type:m.room.member", {
                content: {
                    membership: "leave"
                },
                user_id: testUser.id,
                state_key: testUser.id,
                room_id: roomMapping.roomId,
                type: "m.room.member"
            }).done(function() {
                done();
            });
        });

        it("should join all IRC channels if there are many Matrix joins for the same user",
        test.coroutine(function*() {
            const newUser = {
                id: "@newuser:localhost",
                nick: "M-newuser"
            };

            const expectJoins = ["#a", "#b", "#c"];
            const joined = [];
            env.ircMock._whenClient(roomMapping.server, newUser.nick, "join",
            function(client, channel, cb) {
                joined.push(channel);
                client._invokeCallback(cb);
            });

            const promises = [];
            promises.push(env.mockAppService._trigger("type:m.room.member", {
                content: {
                    membership: "join"
                },
                user_id: newUser.id,
                state_key: newUser.id,
                room_id: "!a:localhost",
                type: "m.room.member"
            }));
            promises.push(env.mockAppService._trigger("type:m.room.member", {
                content: {
                    membership: "join"
                },
                user_id: newUser.id,
                state_key: newUser.id,
                room_id: "!b:localhost",
                type: "m.room.member"
            }));
            promises.push(env.mockAppService._trigger("type:m.room.member", {
                content: {
                    membership: "join"
                },
                user_id: newUser.id,
                state_key: newUser.id,
                room_id: "!c:localhost",
                type: "m.room.member"
            }));
            try {
                yield Promise.all(promises);
            }
            catch (err) {
                expect(true).toBe(false, "onMessage threw " + err);
            }
            expect(joined.length).toEqual(3, "Unexpected number of joins");
            expect(joined.sort()).toEqual(expectJoins);
        }));
    });

    describe("IRC users on Matrix", function() {
        var sdk;
        var ircUser = {
            nick: "bob",
            localpart: roomMapping.server + "_bob",
            id: "@" + roomMapping.server + "_bob:" + config.homeserver.domain
        };
        beforeEach(function() {
            sdk = env.clientMock._client(ircUser.id);
            // add registration mock impl:
            // registering should be for the irc user
            sdk._onHttpRegister({
                expectLocalpart: ircUser.localpart,
                returnUserId: ircUser.id
            });
        });

        it("should join the matrix room when the IRC user joins", function(done) {
            sdk.joinRoom.and.callFake(function(roomId) {
                expect(roomId).toEqual(roomMapping.roomId);
                done();
                return Promise.resolve();
            });

            env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(
            function(client) {
                client.emit("join", roomMapping.channel, ircUser.nick);
            });
        });

        it("should leave the matrix room when the IRC user parts", function(done) {
            sdk.leave.and.callFake(function(roomId) {
                expect(roomId).toEqual(roomMapping.roomId);
                done();
                return Promise.resolve();
            });

            env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(
            function(client) {
                client.emit("part", roomMapping.channel, ircUser.nick);
            });
        });
    });
});
