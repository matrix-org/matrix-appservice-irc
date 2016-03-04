/*
 * Contains integration tests for private messages.
 */
"use strict";
var Promise = require("bluebird");
var promiseutil = require("../../lib/promiseutil");
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

    var registerDefer, joinRoomDefer, roomStateDefer;

    beforeEach(function(done) {
        test.beforeEach(this, env); // eslint-disable-line no-invalid-this

        // reset the deferreds
        registerDefer = promiseutil.defer();
        joinRoomDefer = promiseutil.defer();
        roomStateDefer = promiseutil.defer();

        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );

        test.initEnv(env).done(function() {
            done();
        });
    });

    it("should join 1:1 rooms invited from matrix", function(done) {
        // there's a number of actions we want this to do, so track them to make
        // sure they are all called.
        var globalPromise = Promise.all([
            registerDefer.promise, joinRoomDefer.promise,
            roomStateDefer.promise
        ]);

        // get the ball rolling
        env.mockAppService._trigger("type:m.room.member", {
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
        var sdk = env.clientMock._client();
        sdk._onHttpRegister({
            expectLocalpart: tUserLocalpart,
            returnUserId: tIrcUserId,
            andResolve: registerDefer
        });
        sdk.joinRoom.andCallFake(function(roomId) {
            expect(roomId).toEqual(roomMapping.roomId);
            joinRoomDefer.resolve();
            return Promise.resolve({});
        });
        sdk.roomState.andCallFake(function(roomId) {
            expect(roomId).toEqual(roomMapping.roomId);
            roomStateDefer.resolve({});
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

        globalPromise.done(function() {
            done();
        }, function() {});
    });

    it("should join group chat rooms invited from matrix then leave them",
    function(done) {
        // additional actions on group chat rooms
        var sendMessageDefer = promiseutil.defer();
        var leaveRoomDefer = promiseutil.defer();

        var globalPromise = Promise.all([
            registerDefer.promise, joinRoomDefer.promise,
            roomStateDefer.promise, leaveRoomDefer.promise,
            sendMessageDefer.promise
        ]);

        // get the ball rolling
        env.mockAppService._trigger("type:m.room.member", {
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
        var sdk = env.clientMock._client();
        sdk._onHttpRegister({
            expectLocalpart: tUserLocalpart,
            returnUserId: tIrcUserId,
            andResolve: registerDefer
        });

        // when it tries to join, accept it
        sdk.joinRoom.andCallFake(function(roomId) {
            expect(roomId).toEqual(roomMapping.roomId);
            joinRoomDefer.resolve();
            return Promise.resolve({});
        });
        // see if it sends a message (to say it doesn't do group chat)
        sdk.sendEvent.andCallFake(function(roomId, type, content) {
            expect(roomId).toEqual(roomMapping.roomId);
            expect(type).toEqual("m.room.message");
            sendMessageDefer.resolve();
            return Promise.resolve({});
        });
        // when it tries to leave, accept it
        sdk.leave.andCallFake(function(roomId) {
            expect(roomId).toEqual(roomMapping.roomId);
            leaveRoomDefer.resolve();
            return Promise.resolve({});
        });
        sdk.roomState.andCallFake(function(roomId) {
            expect(roomId).toEqual(roomMapping.roomId);
            roomStateDefer.resolve({});
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

        globalPromise.done(function() {
            done();
        }, function() {});
    });
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

    beforeEach(function(done) {
        test.beforeEach(this, env); // eslint-disable-line no-invalid-this
        sdk = env.clientMock._client();

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
        test.initEnv(env).then(function() {
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
        }).done(function() {
            done();
        });
    });

    it("should create a 1:1 matrix room and invite the real matrix user when " +
    "it receives a PM directed at a virtual user from a real IRC user",
    function(done) {
        var createRoomDefer = promiseutil.defer();
        var sendMsgDefer = promiseutil.defer();
        var promises = Promise.all([
            createRoomDefer.promise, sendMsgDefer.promise
        ]);
        // mock create room impl
        sdk.createRoom.andCallFake(function(opts) {
            expect(opts.visibility).toEqual("private");
            expect(opts.invite).toEqual([tRealUserId]);
            createRoomDefer.resolve();
            return Promise.resolve({
                room_id: tCreatedRoomId
            });
        });
        // mock send message impl
        sdk.sendEvent.andCallFake(function(roomId, type, content) {
            expect(roomId).toEqual(tCreatedRoomId);
            expect(type).toEqual("m.room.message");
            expect(content).toEqual({
                body: tText,
                msgtype: "m.text"
            });
            sendMsgDefer.resolve();
            return Promise.resolve({});
        });

        // test completes after all the matrix actions are done
        promises.done(function() {
            done();
        });

        // find the *VIRTUAL CLIENT* (not the bot) and send the irc message
        env.ircMock._findClientAsync(roomMapping.server, tRealMatrixUserNick).done(
        function(client) {
            client.emit(
                "message", tRealIrcUserNick, tRealMatrixUserNick, tText
            );
        });
    });
});
