const envBundle = require("../util/env-bundle");

describe("Mirroring", () => {
    const {env, config, roomMapping, test} = envBundle();

    // set up config.yaml flags
    config.ircService.servers[roomMapping.server].membershipLists.enabled = true;
    config.ircService.servers[
        roomMapping.server
    ].membershipLists.global.ircToMatrix.incremental = true;
    config.ircService.servers[
        roomMapping.server
    ].membershipLists.global.matrixToIrc.incremental = true;

    // add additional mappings
    config.ircService.servers[roomMapping.server].mappings["#a"] = { roomIds: ["!a:localhost"] };
    config.ircService.servers[roomMapping.server].mappings["#b"] = { roomIds: ["!b:localhost"] };
    config.ircService.servers[roomMapping.server].mappings["#c"] = { roomIds: ["!c:localhost"] };

    const testUser = {
        id: "@flibble:wibble",
        nick: "M-flibble"
    };

    beforeEach(async () => {
        await test.beforeEach(env);

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
        env.ircMock._autoJoinChannels(
            roomMapping.server, roomMapping.botNick, "#a"
        );
        env.ircMock._autoJoinChannels(
            roomMapping.server, roomMapping.botNick, "#b"
        );
        env.ircMock._autoJoinChannels(
            roomMapping.server, roomMapping.botNick, "#c"
        );

        await test.initEnv(env);
    });

    afterEach(async () => test.afterEach(env));

    describe("Matrix users on IRC", () => {
        it("should join the IRC channel when the Matrix user joins", (done) => {
            let joined = false;
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
            }).then(function() {
                expect(joined).toBe(true, "Didn't join");
                done();
            });
        });

        it("should part the IRC channel when the Matrix user leaves", (done) => {
            let parted = false;
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
            }).then(function() {
                expect(parted).toBe(true, "Didn't part");
                done();
            });
        });

        it("should no-op if a Matrix user joins a room not being tracked", (done) => {
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
            }).then(function() {
                done();
            });
        });

        it("should no-op if a Matrix user leaves a room and they aren't connected to the IRC channel", (done) => {
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
            }).then(function() {
                done();
            });
        });

        it("should join all IRC channels if there are many Matrix joins for the same user", async () => {
            const newUser = {
                id: "@newuser:localhost",
                nick: "M-newuser"
            };
            env.ircMock._autoConnectNetworks(
                roomMapping.server, newUser.nick, roomMapping.server
            );

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
                await Promise.all(promises);
            }
            catch (err) {
                expect(true).toBe(false, "onMessage threw " + err);
            }
            expect(joined.length).toEqual(3, "Unexpected number of joins");
            expect(joined.sort()).toEqual(expectJoins);
        });
    });

    describe("IRC users on Matrix", () => {
        let intent, sdk;
        let ircUser = {
            nick: "bob",
            localpart: roomMapping.server + "_bob",
            id: "@" + roomMapping.server + "_bob:" + config.homeserver.domain
        };
        beforeEach(() => {
            intent = env.clientMock._intent(ircUser.id);
            sdk = intent.underlyingClient;
            // add registration mock impl:
            // registering should be for the irc user
            intent._onHttpRegister({
                expectLocalpart: ircUser.localpart,
                returnUserId: ircUser.id
            });
        });

        it("should join the matrix room when the IRC user joins", (done) => {
            sdk.joinRoom.and.callFake(function(roomId) {
                expect(roomId).toEqual(roomMapping.roomId);
                done();
                return Promise.resolve();
            });

            env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).then(
            function(client) {
                client.emit("join", roomMapping.channel, ircUser.nick);
            });
        });

        it("should leave the matrix room when the IRC user parts", async () => {
            const leavePromise = new Promise(r => intent.leaveRoom.and.callFake((roomId) => {
                expect(roomId).toEqual(roomMapping.roomId);
                r();
                return {};
            }));

            const client = await env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick);
            client.emit("part", roomMapping.channel, ircUser.nick);
            await leavePromise;
        });

        it("should leave the matrix room with a reason when the IRC user parts", async () => {
            const leavePromise = new Promise(r => sdk.kickUser.and.callFake(async (userId, roomId, reason) => {
                expect(userId).toEqual(ircUser.id);
                expect(reason).toEqual("Part: has been whacked with a wet trout");
                expect(roomId).toEqual(roomMapping.roomId);
                r();
                return {};
            }));

            const client = await env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick);
            client.emit("part", roomMapping.channel, ircUser.nick, "has been whacked with a wet trout");
            await leavePromise;
        });
    });
});
