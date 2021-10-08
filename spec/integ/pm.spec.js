/*
 * Contains integration tests for private messages.
 */
const envBundle = require("../util/env-bundle");

describe("Matrix-to-IRC PMing", () => {

    const {env, config, roomMapping, test} = envBundle();

    const tUserId = "@flibble:wibble";
    const tIrcNick = "someone";
    const tUserLocalpart = roomMapping.server + "_" + tIrcNick;
    const tIrcUserId = "@" + tUserLocalpart + ":" + config.homeserver.domain;

    beforeEach(async () => {
        await test.beforeEach(env);

        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );

        await test.initEnv(env);
    });

    afterEach(async () => test.afterEach(env));

    it("should join 1:1 rooms invited from matrix", async () => {
        // get the ball rolling
        const requestPromise = env.mockAppService._trigger("type:m.room.member", {
            content: {
                membership: "invite",
                is_direct: true,
            },
            state_key: tIrcUserId,
            user_id: tUserId,
            room_id: roomMapping.roomId,
            type: "m.room.member"
        });

        // when it queries whois, say they exist
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "whois", (_client, nick, cb) => {
            expect(nick).toEqual(tIrcNick);
            // say they exist (presence of user key)
            cb({
                user: tIrcNick,
                nick: tIrcNick
            });
        });

        // when it tries to register, join the room and get state, accept them
        const intent = env.clientMock._intent(tIrcUserId);
        intent._onHttpRegister({
            expectLocalpart: tUserLocalpart,
            returnUserId: tIrcUserId
        });

        let joinRoomPromise = new Promise((resolve, reject) => {
            intent.underlyingClient.joinRoom.and.callFake((roomId) => {
                expect(roomId).toEqual(roomMapping.roomId);
                resolve();
                return Promise.resolve({});
            });
        });

        await joinRoomPromise;
        await requestPromise;
    });

    it("should join group chat rooms invited from matrix then leave them", async () => {
        const expectedReason = "Group chat not supported.";
        // get the ball rolling
        const requestPromise = env.mockAppService._trigger("type:m.room.member", {
            content: {
                membership: "invite",
            },
            state_key: tIrcUserId,
            user_id: tUserId,
            room_id: roomMapping.roomId,
            type: "m.room.member"
        });

        // when it queries whois, say they exist
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "whois", (client, nick, cb) => {
            expect(nick).toEqual(tIrcNick);
            // say they exist (presence of user key)
            cb({
                user: tIrcNick,
                nick: tIrcNick
            });
        });

        // when it tries to register, join the room and get state, accept them
        const intent = env.clientMock._intent(tIrcUserId);
        const sdk = intent.underlyingClient;
        intent._onHttpRegister({
            expectLocalpart: tUserLocalpart,
            returnUserId: tIrcUserId
        });

        // when it tries to join, accept it
        const joinRoomPromise = new Promise((resolve) => {
            sdk.joinRoom.and.callFake((roomId) => {
                expect(roomId).toEqual(roomMapping.roomId);
                resolve();
                return Promise.resolve({});
            });
        });

        // when it tries to leave, accept it
        const kickPromise = new Promise((resolve) => {
            sdk.kickUser.and.callFake((userId, roomId, reason) => {
                expect(roomId).toEqual(roomMapping.roomId);
                expect(userId).toEqual(tIrcUserId);
                expect(reason).toEqual(expectedReason);
                resolve();
                return Promise.resolve({});
            });
        });


        // wait on things to happen
        await joinRoomPromise;
        await kickPromise;
        await requestPromise;
    });
});

describe("Matrix-to-IRC PMing disabled", () => {
    const {env, config, roomMapping, test} = envBundle();

    const tUserId = "@flibble:wibble";
    const tIrcNick = "someone";
    const tUserLocalpart = roomMapping.server + "_" + tIrcNick;
    const tIrcUserId = "@" + tUserLocalpart + ":" + config.homeserver.domain;

    beforeEach(async () => {
        config.ircService.servers[roomMapping.server].privateMessages.enabled = false;
        await test.beforeEach(env);

        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );

        await test.initEnv(env);
    });

    afterEach(async () => {
        await test.afterEach(env);
        config.ircService.servers[roomMapping.server].privateMessages.enabled = true;
    });

    it("should join 1:1 rooms invited from matrix, announce and then leave them", async () => {
        // get the ball rolling
        const requestPromise = env.mockAppService._trigger("type:m.room.member", {
            content: {
                membership: "invite",
                is_direct: true,
            },
            state_key: tIrcUserId,
            user_id: tUserId,
            room_id: roomMapping.roomId,
            type: "m.room.member"
        });

        // when it queries whois, say they exist
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "whois", (nick, cb) => {
            expect(nick).toEqual(tIrcNick);
            // say they exist (presence of user key)
            cb({
                user: tIrcNick,
                nick: tIrcNick
            });
        });

        const intent = env.clientMock._intent(tIrcUserId);
        const sdk = intent.underlyingClient;
        intent._onHttpRegister({
            expectLocalpart: tUserLocalpart,
            returnUserId: tIrcUserId
        });

        const joinRoomPromise = new Promise((resolve, reject) => {
            sdk.joinRoom.and.callFake(function(roomId) {
                expect(roomId).toEqual(roomMapping.roomId);
                resolve();
                return Promise.resolve({});
            });
        });

        const sentMessagePromise = new Promise(function(resolve, reject) {
            sdk.sendEvent.and.callFake(function(roomId, type, content) {
                expect(roomId).toEqual(roomMapping.roomId);
                expect(type).toEqual("m.room.message");
                resolve();
                return Promise.resolve({});
            });
        });

        const leaveRoomPromise = new Promise((resolve, reject) => {
            intent.leaveRoom.and.callFake(function(roomId) {
                expect(roomId).toEqual(roomMapping.roomId);
                resolve();
                return Promise.resolve({});
            });
        });

        await joinRoomPromise;
        await sentMessagePromise;
        await leaveRoomPromise;
        await requestPromise;
    });
});

describe("IRC-to-Matrix PMing", () => {
    const {env, config, roomMapping, test} = envBundle();
    let sdk = null;

    const tRealIrcUserNick = "bob";
    const tVirtualUserId = `@${roomMapping.server}_${tRealIrcUserNick}:${config.homeserver.domain}`;
    const tRealMatrixUserNick = "M-alice";
    const tRealUserId = "@alice:anotherhomeserver";
    const tCreatedRoomId = "!fehwfweF:fuiowehfwe";
    const tText = "ello ello ello";

    beforeEach(async () => {
        await test.beforeEach(env);
        const intent = env.clientMock._intent(tVirtualUserId);
        sdk = intent.underlyingClient;

        // add registration mock impl:
        // registering should be for the REAL irc user
        intent._onHttpRegister({
            expectLocalpart: roomMapping.server + "_" + tRealIrcUserNick,
            returnUserId: tVirtualUserId
        });

        // let the user join when they send a message
        env.ircMock._autoConnectNetworks(
            roomMapping.server, tRealMatrixUserNick, roomMapping.server
        );
        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );
        env.ircMock._autoJoinChannels(
            roomMapping.server, tRealMatrixUserNick, roomMapping.channel
        );

        await test.initEnv(env);

        // send a message in the linked room (so the service provisions a
        // virtual IRC user which the 'real' IRC users can speak to)
        return env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "get me in",
                msgtype: "m.text"
            },
            user_id: tRealUserId,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        });
    });

    afterEach(async () => test.afterEach(env));

    it("should create a 1:1 matrix room and invite the real matrix user when " +
    "it receives a PM directed at a virtual user from a real IRC user", async () => {
        // mock create room impl
        const createRoomPromise = new Promise((resolve) => {
            sdk.createRoom.and.callFake((opts) => {
                expect(opts.visibility).toEqual("private");
                expect(opts.creation_content["m.federate"]).toEqual(true);
                expect(opts.preset).not.toBeDefined();
                expect(opts.initial_state).toEqual([{
                    type: "m.room.power_levels",
                    state_key: "",
                    content: {
                        users: {
                            "@alice:anotherhomeserver": 10,
                            "@irc.example_bob:some.home.server": 100
                        },
                        events: {
                            "m.room.avatar": 10,
                            "m.room.name": 10,
                            "m.room.canonical_alias": 100,
                            "m.room.history_visibility": 100,
                            "m.room.power_levels": 100,
                            "m.room.encryption": 100
                        },
                        invite: 100
                    },
                }]);
                resolve();
                return tCreatedRoomId;
            });
        });

        // mock send message impl
        let sentMessagePromise = new Promise(function(resolve, reject) {
            sdk.sendEvent.and.callFake(function(roomId, type, content) {
                expect(roomId).toEqual(tCreatedRoomId);
                expect(type).toEqual("m.room.message");
                expect(content).toEqual({
                    body: tText,
                    msgtype: "m.text"
                });
                resolve();
                return Promise.resolve({});
            });
        });

        // find the *VIRTUAL CLIENT* (not the bot) and send the irc message
        let client = await env.ircMock._findClientAsync(
            roomMapping.server, tRealMatrixUserNick
        );
        client.emit(
            "message", tRealIrcUserNick, tRealMatrixUserNick, tText
        );

        await createRoomPromise;
        await sentMessagePromise;
    });

    it("should not create multiple matrix rooms when several PMs are received in quick succession", async () => {
        let count = 0;
        // mock create room impl
        let createRoomPromise = new Promise((resolve) => {
            sdk.createRoom.and.callFake((opts) => {
                count++;
                expect(count).toEqual(1);
                resolve();
                return tCreatedRoomId;
            });
        });
        let MESSAGE_COUNT = 10;
        let receivedMessageCount = 0;

        // mock send message impl
        let sentMessagePromise = new Promise(function(resolve, reject) {
            sdk.sendEvent.and.callFake(() => {
                receivedMessageCount++;
                if (receivedMessageCount === MESSAGE_COUNT) {
                    resolve();
                }
            });
        });

        // find the *VIRTUAL CLIENT* (not the bot) and send the irc message
        let client = await env.ircMock._findClientAsync(
            roomMapping.server, tRealMatrixUserNick
        );

        // Send several messages, almost at once, to simulate a race
        for (let i = 0; i < MESSAGE_COUNT; i++) {
            client.emit("message", tRealIrcUserNick, tRealMatrixUserNick, tText);
        }

        await createRoomPromise;
        await sentMessagePromise;
    });
});

describe("IRC-to-Matrix Non-Federated PMing", function() {
    const {env, config, roomMapping, test} = envBundle();

    let sdk = null;

    const tRealIrcUserNick = "bob";
    const tVirtualUserId = "@" + roomMapping.server + "_" + tRealIrcUserNick + ":" +
                          config.homeserver.domain;

    const tRealMatrixUserNick = "M-alice";
    const tRealUserId = "@alice:anotherhomeserver";

    const tCreatedRoomId = "!fehwfweF:fuiowehfwe";

    const tText = "ello ello ello";

    beforeEach(async () => {
        config.ircService.servers[roomMapping.server].privateMessages.federate = false;
        await test.beforeEach(env);
        const intent = env.clientMock._intent(tVirtualUserId);
        sdk = intent.underlyingClient;

        // add registration mock impl:
        // registering should be for the REAL irc user
        intent._onHttpRegister({
            expectLocalpart: roomMapping.server + "_" + tRealIrcUserNick,
            returnUserId: tVirtualUserId
        });

        // let the user join when they send a message
        env.ircMock._autoConnectNetworks(
            roomMapping.server, tRealMatrixUserNick, roomMapping.server
        );
        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );
        env.ircMock._autoJoinChannels(
            roomMapping.server, tRealMatrixUserNick, roomMapping.channel
        );

        await test.initEnv(env);

        // send a message in the linked room (so the service provisions a
        // virtual IRC user which the 'real' IRC users can speak to)
        return env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "get me in",
                msgtype: "m.text"
            },
            user_id: tRealUserId,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        });
    });

    afterEach(async () => test.afterEach(env));

    it("should create a non-federated 1:1 matrix room and invite the real matrix user when " +
    "it receives a PM directed at a virtual user from a real IRC user", async () => {
        // mock create room impl
        const createRoomPromise = new Promise((resolve) => {
            sdk.createRoom.and.callFake((opts) => {
                expect(opts.visibility).toEqual("private");
                expect(opts.creation_content["m.federate"]).toEqual(false);
                resolve();
                return tCreatedRoomId;
            });
        });

        // mock send message impl
        const sentMessagePromise = new Promise((resolve) => {
            sdk.sendEvent.and.callFake((roomId, type, content) => {
                expect(roomId).toEqual(tCreatedRoomId);
                expect(type).toEqual("m.room.message");
                expect(content).toEqual({
                    body: tText,
                    msgtype: "m.text"
                });
                resolve();
                return {};
            });
        });

        // find the *VIRTUAL CLIENT* (not the bot) and send the irc message
        const client = await env.ircMock._findClientAsync(
            roomMapping.server, tRealMatrixUserNick
        );
        client.emit(
            "message", tRealIrcUserNick, tRealMatrixUserNick, tText
        );

        await createRoomPromise;
        await sentMessagePromise;
    });
});

describe("Matrix-to-IRC PMing over federation disabled", function() {
    const {env, config, roomMapping, test} = envBundle();

    const tUserId = "@flibble:wobble";
    const tIrcNick = "someone";
    const tUserLocalpart = roomMapping.server + "_" + tIrcNick;
    const tIrcUserId = "@" + tUserLocalpart + ":" + config.homeserver.domain;

    beforeEach(async () => {
        config.ircService.servers[roomMapping.server].privateMessages.federate = false;
        await test.beforeEach(env);

        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );

        await test.initEnv(env);
    });

    afterEach(async () => {
        await test.afterEach(env);
        config.ircService.servers[roomMapping.server].privateMessages.federate = true;
    });

    it("should join 1:1 rooms invited from matrix, announce and then leave them", async () => {
        // get the ball rolling
        let requestPromise = env.mockAppService._trigger("type:m.room.member", {
            content: {
                membership: "invite",
                is_direct: true,
            },
            state_key: tIrcUserId,
            user_id: tUserId,
            room_id: roomMapping.roomId,
            type: "m.room.member"
        });

        // when it queries whois, say they exist
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "whois",
        function(client, nick, cb) {
            expect(nick).toEqual(tIrcNick);
            // say they exist (presence of user key)
            cb({
                user: tIrcNick,
                nick: tIrcNick
            });
        });

        const intent = env.clientMock._intent(tIrcUserId);
        intent._onHttpRegister({
            expectLocalpart: tUserLocalpart,
            returnUserId: tIrcUserId
        });
        const sdk = intent.underlyingClient;

        let joinRoomPromise = new Promise((resolve, reject) => {
            sdk.joinRoom.and.callFake(function(roomId) {
                expect(roomId).toEqual(roomMapping.roomId);
                resolve();
                return Promise.resolve({});
            });
        });

        let sentMessagePromise = new Promise(function(resolve, reject) {
            sdk.sendEvent.and.callFake(function(roomId, type, content) {
                expect(roomId).toEqual(roomMapping.roomId);
                expect(type).toEqual("m.room.message");
                resolve();
                return Promise.resolve({});
            });
        });

        let leaveRoomPromise = new Promise((resolve, reject) => {
            intent.leaveRoom.and.callFake(function(roomId) {
                expect(roomId).toEqual(roomMapping.roomId);
                resolve();
                return Promise.resolve({});
            });
        });

        await joinRoomPromise;
        await sentMessagePromise;
        await leaveRoomPromise;
        await requestPromise;
    });
});
