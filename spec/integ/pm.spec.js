/*
 * Contains integration tests for private messages.
 */
"use strict";
var Promise = require("bluebird");
var test = require("../util/test");

// set up integration testing mocks
var env = test.mkEnv();

var config = env.config;
var roomMapping = {
    server: config._server,
    botNick: config._botnick,
    channel: config._chan,
    roomId: config._roomid
};

describe("Matrix-to-IRC PMing", function() {
    var tUserId = "@flibble:wibble";
    var tIrcNick = "someone";
    var tUserLocalpart = roomMapping.server + "_" + tIrcNick;
    var tIrcUserId = "@" + tUserLocalpart + ":" + config.homeserver.domain;

    beforeEach(test.coroutine(function*() {
        yield test.beforeEach(env);

        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );

        yield test.initEnv(env);
    }));

    afterEach(test.coroutine(function*() {
        yield test.afterEach(env);
    }));

    it("should join 1:1 rooms invited from matrix",
    test.coroutine(function*() {
        // get the ball rolling
        let requestPromise = env.mockAppService._trigger("type:m.room.member", {
            content: {
                membership: "invite"
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

        // when it tries to register, join the room and get state, accept them
        let sdk = env.clientMock._client(tIrcUserId);
        sdk._onHttpRegister({
            expectLocalpart: tUserLocalpart,
            returnUserId: tIrcUserId
        });

        let joinRoomPromise = new Promise((resolve, reject) => {
            sdk.joinRoom.and.callFake(function(roomId) {
                expect(roomId).toEqual(roomMapping.roomId);
                resolve();
                return Promise.resolve({});
            });
        });

        let roomStatePromise = new Promise((resolve, reject) => {
            sdk.roomState.and.callFake(function(roomId) {
                expect(roomId).toEqual(roomMapping.roomId);
                resolve();
                return Promise.resolve([
                    {
                        content: {membership: "join"},
                        user_id: tIrcUserId,
                        state_key: tIrcUserId,
                        room_id: roomMapping.roomId,
                        type: "m.room.member"
                    },
                    {
                        content: {membership: "join"},
                        user_id: tUserId,
                        state_key: tUserId,
                        room_id: roomMapping.roomId,
                        type: "m.room.member"
                    }
                ]);
            });
        });

        yield joinRoomPromise;
        yield roomStatePromise;
        yield requestPromise;
    }));

    it("should join group chat rooms invited from matrix then leave them",
    test.coroutine(function*() {
        // get the ball rolling
        let requestPromise = env.mockAppService._trigger("type:m.room.member", {
            content: {
                membership: "invite"
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

        // when it tries to register, join the room and get state, accept them
        var sdk = env.clientMock._client(tIrcUserId);
        sdk._onHttpRegister({
            expectLocalpart: tUserLocalpart,
            returnUserId: tIrcUserId
        });

        // when it tries to join, accept it
        let joinRoomPromise = new Promise((resolve, reject) => {
            sdk.joinRoom.and.callFake(function(roomId) {
                expect(roomId).toEqual(roomMapping.roomId);
                resolve();
                return Promise.resolve({});
            });
        });

        // see if it sends a message (to say it doesn't do group chat)
        let sendMessagePromise = new Promise((resolve, reject) => {
            sdk.sendEvent.and.callFake(function(roomId, type, content) {
                expect(roomId).toEqual(roomMapping.roomId);
                expect(type).toEqual("m.room.message");
                resolve();
                return Promise.resolve({});
            });
        });

        // when it tries to leave, accept it
        let leaveRoomPromise = new Promise((resolve, reject) => {
            sdk.leave.and.callFake(function(roomId) {
                expect(roomId).toEqual(roomMapping.roomId);
                resolve();
                return Promise.resolve({});
            });
        });

        let roomStatePromise = new Promise((resolve, reject) => {
            sdk.roomState.and.callFake(function(roomId) {
                expect(roomId).toEqual(roomMapping.roomId);
                resolve();
                return Promise.resolve([
                {
                    content: {membership: "join"},
                    user_id: tIrcUserId,
                    state_key: tIrcUserId,
                    room_id: roomMapping.roomId,
                    type: "m.room.member"
                },
                {
                    content: {membership: "join"},
                    user_id: tUserId,
                    state_key: tUserId,
                    room_id: roomMapping.roomId,
                    type: "m.room.member"
                },
                // Group chat, so >2 users!
                {
                    content: {membership: "join"},
                    user_id: "@someone:else",
                    state_key: "@someone:else",
                    room_id: roomMapping.roomId,
                    type: "m.room.member"
                }
                ]);
            });
        });

        // wait on things to happen
        yield joinRoomPromise;
        yield roomStatePromise;
        yield sendMessagePromise;
        yield leaveRoomPromise;
        yield requestPromise;
    }));
});

describe("Matrix-to-IRC PMing disabled", function() {
    var tUserId = "@flibble:wibble";
    var tIrcNick = "someone";
    var tUserLocalpart = roomMapping.server + "_" + tIrcNick;
    var tIrcUserId = "@" + tUserLocalpart + ":" + config.homeserver.domain;

    beforeEach(test.coroutine(function*() {
        config.ircService.servers[roomMapping.server].privateMessages.enabled = false;
        yield test.beforeEach(env);

        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );

        yield test.initEnv(env);
    }));

    afterEach(test.coroutine(function*() {
        yield test.afterEach(env);
        config.ircService.servers[roomMapping.server].privateMessages.enabled = true;
    }));

    it("should join 1:1 rooms invited from matrix, announce and then leave them",
    test.coroutine(function*() {
        // get the ball rolling
        let requestPromise = env.mockAppService._trigger("type:m.room.member", {
            content: {
                membership: "invite"
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

        let sdk = env.clientMock._client(tIrcUserId);
        sdk._onHttpRegister({
            expectLocalpart: tUserLocalpart,
            returnUserId: tIrcUserId
        });

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
            sdk.leave.and.callFake(function(roomId) {
                expect(roomId).toEqual(roomMapping.roomId);
                resolve();
                return Promise.resolve({});
            });
        });

        yield joinRoomPromise;
        yield sentMessagePromise;
        yield leaveRoomPromise;
        yield requestPromise;
    }));
});

describe("IRC-to-Matrix PMing", function() {
    var sdk = null;

    var tRealIrcUserNick = "bob";
    var tVirtualUserId = "@" + roomMapping.server + "_" + tRealIrcUserNick + ":" +
                          config.homeserver.domain;

    var tRealMatrixUserNick = "M-alice";
    var tRealUserId = "@alice:anotherhomeserver";

    var tCreatedRoomId = "!fehwfweF:fuiowehfwe";

    var tText = "ello ello ello";

    beforeEach(test.coroutine(function*() {
        yield test.beforeEach(env);
        sdk = env.clientMock._client(tVirtualUserId);

        // add registration mock impl:
        // registering should be for the REAL irc user
        sdk._onHttpRegister({
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

        // do the init
        yield test.initEnv(env).then(function() {
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
    }));

    afterEach(test.coroutine(function*() {
        yield test.afterEach(env);
    }));

    it("should create a 1:1 matrix room and invite the real matrix user when " +
    "it receives a PM directed at a virtual user from a real IRC user",
    test.coroutine(function*() {
        // mock create room impl
        let createRoomPromise = new Promise(function(resolve, reject) {
            sdk.createRoom.and.callFake(function(opts) {
                expect(opts.visibility).toEqual("private");
                expect(opts.invite).toEqual([tRealUserId]);
                expect(opts.creation_content["m.federate"]).toEqual(true);
                resolve();
                return Promise.resolve({
                    room_id: tCreatedRoomId
                });
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
        let client = yield env.ircMock._findClientAsync(
            roomMapping.server, tRealMatrixUserNick
        );
        client.emit(
            "message", tRealIrcUserNick, tRealMatrixUserNick, tText
        );

        yield createRoomPromise;
        yield sentMessagePromise;
    }));

    it("should not create multiple matrix rooms when several PMs are received in quick succession",
    test.coroutine(function*() {
        let count = 0;
        // mock create room impl
        let createRoomPromise = new Promise(function(resolve, reject) {
            sdk.createRoom.and.callFake(function(opts) {
                count++;
                expect(count).toEqual(1);
                resolve();
                return Promise.resolve({
                    room_id: tCreatedRoomId
                });
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
        let client = yield env.ircMock._findClientAsync(
            roomMapping.server, tRealMatrixUserNick
        );

        // Send several messages, almost at once, to simulate a race
        for (var i = 0; i < MESSAGE_COUNT; i++) {
            client.emit("message", tRealIrcUserNick, tRealMatrixUserNick, tText);
        }

        yield createRoomPromise;
        yield sentMessagePromise;
    }));
});

describe("IRC-to-Matrix Non-Federated PMing", function() {
    var sdk = null;

    var tRealIrcUserNick = "bob";
    var tVirtualUserId = "@" + roomMapping.server + "_" + tRealIrcUserNick + ":" +
                          config.homeserver.domain;

    var tRealMatrixUserNick = "M-alice";
    var tRealUserId = "@alice:anotherhomeserver";

    var tCreatedRoomId = "!fehwfweF:fuiowehfwe";

    var tText = "ello ello ello";

    beforeEach(test.coroutine(function*() {
        config.ircService.servers[roomMapping.server].privateMessages.federate = false;
        yield test.beforeEach(env);
        sdk = env.clientMock._client(tVirtualUserId);

        // add registration mock impl:
        // registering should be for the REAL irc user
        sdk._onHttpRegister({
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

        // do the init
        yield test.initEnv(env).then(function() {
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
    }));

    afterEach(test.coroutine(function*() {
        yield test.afterEach(env);
    }));

    it("should create a non-federated 1:1 matrix room and invite the real matrix user when " +
    "it receives a PM directed at a virtual user from a real IRC user",
    test.coroutine(function*() {
        // mock create room impl
        let createRoomPromise = new Promise(function(resolve, reject) {
            sdk.createRoom.and.callFake(function(opts) {
                expect(opts.visibility).toEqual("private");
                expect(opts.invite).toEqual([tRealUserId]);
                expect(opts.creation_content["m.federate"]).toEqual(false);
                resolve();
                return Promise.resolve({
                    room_id: tCreatedRoomId
                });
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
        let client = yield env.ircMock._findClientAsync(
            roomMapping.server, tRealMatrixUserNick
        );
        client.emit(
            "message", tRealIrcUserNick, tRealMatrixUserNick, tText
        );

        yield createRoomPromise;
        yield sentMessagePromise;
    }));
});

describe("Matrix-to-IRC PMing over federation disabled", function() {
    var tUserId = "@flibble:wobble";
    var tIrcNick = "someone";
    var tUserLocalpart = roomMapping.server + "_" + tIrcNick;
    var tIrcUserId = "@" + tUserLocalpart + ":" + config.homeserver.domain;

    beforeEach(test.coroutine(function*() {
        config.ircService.servers[roomMapping.server].privateMessages.federate = false;
        yield test.beforeEach(env);

        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );

        yield test.initEnv(env);
    }));

    afterEach(test.coroutine(function*() {
        yield test.afterEach(env);
        config.ircService.servers[roomMapping.server].privateMessages.federate = true;
    }));

    it("should join 1:1 rooms invited from matrix, announce and then leave them",
    test.coroutine(function*() {
        // get the ball rolling
        let requestPromise = env.mockAppService._trigger("type:m.room.member", {
            content: {
                membership: "invite"
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

        let sdk = env.clientMock._client(tIrcUserId);
        sdk._onHttpRegister({
            expectLocalpart: tUserLocalpart,
            returnUserId: tIrcUserId
        });

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
            sdk.leave.and.callFake(function(roomId) {
                expect(roomId).toEqual(roomMapping.roomId);
                resolve();
                return Promise.resolve({});
            });
        });

        yield joinRoomPromise;
        yield sentMessagePromise;
        yield leaveRoomPromise;
        yield requestPromise;
    }));
});
