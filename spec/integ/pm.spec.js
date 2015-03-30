/*
 * Contains integration tests for private messages.
 */
"use strict";
// set up integration testing mocks
var proxyquire =  require('proxyquire');
var clientMock = require("../util/client-sdk-mock");
clientMock["@global"] = true; 
var ircMock = require("../util/irc-mock");
ircMock["@global"] = true;
var dbHelper = require("../util/db-helper");
var asapiMock = require("../util/asapi-controller-mock");
var q = require("q");

// set up test config
var appConfig = require("../util/config-mock");
var roomMapping = appConfig.roomMapping;

describe("Matrix-to-IRC PMing", function() {
    var ircService = null;
    var mockAsapiController = null;

    var tUserId = "@flibble:wibble";
    var tIrcNick = "someone";
    var tUserLocalpart = roomMapping.server+"_"+tIrcNick;
    var tIrcUserId = "@"+tUserLocalpart+":"+appConfig.homeServerDomain;

    var whoisDefer, registerDefer, joinRoomDefer, roomStateDefer;

    beforeEach(function(done) {
        console.log(" === PM Matrix-to-IRC Test Start === ");
        ircMock._reset();
        clientMock._reset();
        ircService = proxyquire("../../lib/irc-appservice.js", {
            "matrix-js-sdk": clientMock,
            "irc": ircMock
        });
        mockAsapiController = asapiMock.create();

        // reset the deferreds
        whoisDefer = q.defer();
        registerDefer = q.defer();
        joinRoomDefer = q.defer();
        roomStateDefer = q.defer();

        // do the init
        dbHelper._reset(appConfig.databaseUri).then(function() {
            ircService.configure(appConfig.ircConfig);
            return ircService.register(
                mockAsapiController, appConfig.serviceConfig
            );
        }).done(function() {
            done();
        });
    });

    it("should join 1:1 rooms invited from matrix", function(done) {
        // there's a number of actions we want this to do, so track them to make
        // sure they are all called.
        var globalPromise = q.all([
            whoisDefer.promise, registerDefer.promise, joinRoomDefer.promise,
            roomStateDefer.promise
        ]);

        // get the ball rolling
        mockAsapiController._trigger("type:m.room.member", {
            content: {
                membership: "invite"
            },
            state_key: tIrcUserId,
            user_id: tUserId,
            room_id: roomMapping.roomId,
            type: "m.room.member"
        });

        // when it queries whois, say they exist
        ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).then(
        function(client) {
            return client._triggerConnect();
        }).then(function(client) {
            return client._triggerWhois(tIrcNick, true);
        }).done(function() {
            whoisDefer.resolve();
        });

        // when it tries to register, join the room and get state, accept them
        var sdk = clientMock._client();
        sdk._onHttpRegister({
            expectLocalpart: tUserLocalpart,
            returnUserId: tIrcUserId,
            andResolve: registerDefer
        });
        sdk.joinRoom.andCallFake(function(roomId) {
            expect(roomId).toEqual(roomMapping.roomId);
            joinRoomDefer.resolve();
            return q({});
        });
        sdk.roomState.andCallFake(function(roomId) {
            expect(roomId).toEqual(roomMapping.roomId);
            roomStateDefer.resolve({});
            return q([
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
        }, function(){});
    });

    it("should join group chat rooms invited from matrix then leave them", 
    function(done) {
        // additional actions on group chat rooms
        var sendMessageDefer = q.defer();
        var leaveRoomDefer = q.defer();

        var globalPromise = q.all([
            whoisDefer.promise, registerDefer.promise, joinRoomDefer.promise,
            roomStateDefer.promise, leaveRoomDefer.promise, 
            sendMessageDefer.promise
        ]);

        // get the ball rolling
        mockAsapiController._trigger("type:m.room.member", {
            content: {
                membership: "invite"
            },
            state_key: tIrcUserId,
            user_id: tUserId,
            room_id: roomMapping.roomId,
            type: "m.room.member"
        });

        // when it queries whois, say they exist
        ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).then(
        function(client) {
            return client._triggerConnect();
        }).then(function(client) {
            return client._triggerWhois(tIrcNick, true);
        }).done(function() {
            whoisDefer.resolve();
        });

        // when it tries to register, join the room and get state, accept them
        var sdk = clientMock._client();
        sdk._onHttpRegister({
            expectLocalpart: tUserLocalpart,
            returnUserId: tIrcUserId,
            andResolve: registerDefer
        });

        // when it tries to join, accept it
        sdk.joinRoom.andCallFake(function(roomId) {
            expect(roomId).toEqual(roomMapping.roomId);
            joinRoomDefer.resolve();
            return q({});
        });
        // see if it sends a message (to say it doesn't do group chat)
        sdk.sendMessage.andCallFake(function(roomId, content) {
            expect(roomId).toEqual(roomMapping.roomId);
            sendMessageDefer.resolve();
            return q({});
        });
        // when it tries to leave, accept it
        sdk.leave.andCallFake(function(roomId) {
            expect(roomId).toEqual(roomMapping.roomId);
            leaveRoomDefer.resolve();
            return q({});
        });
        sdk.roomState.andCallFake(function(roomId) {
            expect(roomId).toEqual(roomMapping.roomId);
            roomStateDefer.resolve({});
            return q([
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
        }, function(){});
    });
});

describe("IRC-to-Matrix PMing", function() {
    var ircService = null;
    var mockAsapiController = null;
    var sdk = null;

    var tRealIrcUserNick = "bob";
    var tVirtualUserId = "@"+roomMapping.server+"_"+tRealIrcUserNick+":"+
                          appConfig.homeServerDomain;

    var tRealUserLocalpart = "alice";
    var tRealUserId = "@"+tRealUserLocalpart+":anotherhomeserver";

    var tCreatedRoomId = "!fehwfweF:fuiowehfwe";

    var tText = "ello ello ello";

    beforeEach(function(done) {
        console.log(" === PM Test Start === ");
        ircMock._reset();
        clientMock._reset();
        ircService = proxyquire("../../lib/irc-appservice.js", {
            "matrix-js-sdk": clientMock,
            "irc": ircMock
        });
        mockAsapiController = asapiMock.create();
        sdk = clientMock._client();

        // add registration mock impl:
        // registering should be for the REAL irc user
        sdk._onHttpRegister({
            expectLocalpart: roomMapping.server+"_"+tRealIrcUserNick, 
            returnUserId: tVirtualUserId
        });

        // do the init
        dbHelper._reset(appConfig.databaseUri).then(function() {
            ircService.configure(appConfig.ircConfig);
            return ircService.register(
                mockAsapiController, appConfig.serviceConfig
            );
        }).then(function() {
            // send a message in the linked room (so the service provisions a 
            // virtual IRC user which the 'real' IRC users can speak to)
            mockAsapiController._trigger("type:m.room.message", {
                content: {
                    body: "get me in",
                    msgtype: "m.text"
                },
                user_id: tRealUserId,
                room_id: roomMapping.roomId,
                type: "m.room.message"
            });
            return ircMock._letNickJoinChannel(
                roomMapping.server, tRealUserLocalpart, roomMapping.channel
            );
        }).done(function() {
            done();
        });
    });

    it("should create a 1:1 matrix room and invite the real matrix user when " +
    "it receives a PM directed at a virtual user from a real IRC user", 
    function(done) {
        var createRoomDefer = q.defer();
        var inviteDefer = q.defer();
        var sendMsgDefer = q.defer();
        var promises = q.all([
            createRoomDefer.promise, inviteDefer.promise, sendMsgDefer.promise
        ]);
        // mock create room impl
        sdk.createRoom.andCallFake(function(opts) {
            expect(opts.visibility).toEqual("private");
            createRoomDefer.resolve();
            return q({
                room_id: tCreatedRoomId
            });
        });
        // mock invite impl
        sdk.invite.andCallFake(function(roomId, userId) {
            expect(roomId).toEqual(tCreatedRoomId);
            expect(userId).toEqual(tRealUserId);
            inviteDefer.resolve();
            return q({});
        });
        // mock send message impl
        sdk.sendMessage.andCallFake(function(roomId, content) {
            expect(roomId).toEqual(tCreatedRoomId);
            expect(content).toEqual({
                body: tText,
                msgtype: "m.text"
            });
            sendMsgDefer.resolve();
            return q({});
        });

        // test completes after all the matrix actions are done
        promises.done(function() {
            done();
        });

        // find the *VIRTUAL CLIENT* (not the bot) and send the irc message
        ircMock._findClientAsync(roomMapping.server, tRealUserLocalpart).done(
        function(client) {
            client._trigger(
                "message", [tRealIrcUserNick, tRealUserLocalpart, tText]
            );
        });
    });
});