"use strict";
var Promise = require("bluebird");
var test = require("../util/test");

// set up integration testing mocks
var env = test.mkEnv();

// set up test config
var appConfig = env.appConfig;
var roomMapping = appConfig.roomMapping;

// set up config.yaml flags
appConfig.ircConfig.servers[roomMapping.server].membershipLists.enabled = true;
appConfig.ircConfig.servers[
    roomMapping.server
].membershipLists.global.ircToMatrix.incremental = true;
appConfig.ircConfig.servers[
    roomMapping.server
].membershipLists.global.matrixToIrc.incremental = true;

describe("Mirroring", function() {
    var testUser = {
        id: "@flibble:wibble",
        nick: "M-flibble"
    };

    beforeEach(function(done) {
        test.beforeEach(this, env); // eslint-disable-line no-invalid-this

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
        test.initEnv(env).done(function() {
            done();
        });
    });

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

            env.mockAsapiController._trigger("type:m.room.member", {
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

            env.mockAsapiController._trigger("type:m.room.message", {
                content: {
                    body: "dummy text to get it to join",
                    msgtype: "m.text"
                },
                user_id: testUser.id,
                room_id: roomMapping.roomId,
                type: "m.room.message"
            }).then(function() {
                return env.mockAsapiController._trigger("type:m.room.member", {
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

            env.mockAsapiController._trigger("type:m.room.member", {
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

            env.mockAsapiController._trigger("type:m.room.member", {
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
    });

    describe("IRC users on Matrix", function() {
        var sdk;
        var ircUser = {
            nick: "bob",
            localpart: roomMapping.server + "_bob",
            id: "@" + roomMapping.server + "_bob:" + appConfig.homeServerDomain
        };
        beforeEach(function() {
            sdk = env.clientMock._client();
            // add registration mock impl:
            // registering should be for the irc user
            sdk._onHttpRegister({
                expectLocalpart: ircUser.localpart,
                returnUserId: ircUser.id
            });
        });

        it("should join the matrix room when the IRC user joins", function(done) {
            sdk.joinRoom.andCallFake(function(roomId) {
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
            sdk.leave.andCallFake(function(roomId) {
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
