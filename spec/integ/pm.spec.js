/*
 * Contains integration tests for all IRC-initiated events.
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

// s prefix for static test data, t prefix for test instance data
var sDatabaseUri = "mongodb://localhost:27017/matrix-appservice-irc-integration";
var sIrcServer = "irc.example";
var sBotNick = "a_nick";
var sChannel = "#coffee";
var sRoomId = "!foo:bar";
var sRoomMapping = {};
sRoomMapping[sChannel] = [sRoomId];
var sHomeServerUrl = "https://some.home.server.goeshere";
var sHomeServerDomain = "some.home.server";
var sAppServiceToken = "it's a secret";
var sAppServiceUrl = "https://mywuvelyappservicerunninganircbridgeyay.gome";
var sPort = 2;


// set up config
var ircConfig = {
    databaseUri: sDatabaseUri,
    servers: {}
};
ircConfig.servers[sIrcServer] = {
    nick: sBotNick,
    expose: {
        channels: true,
        privateMessages: true
    },
    rooms: {
        mappings: sRoomMapping
    }
}
var serviceConfig = {
    hs: sHomeServerUrl,
    hsDomain: sHomeServerDomain,
    token: sAppServiceToken,
    as: sAppServiceUrl,
    port: sPort
};

describe("Matrix-to-IRC PMing", function() {
    var ircService = null;
    var mockAsapiController = null;

    beforeEach(function(done) {
        console.log(" === PM Matrix-to-IRC Test Start === ");
        ircMock._reset();
        clientMock._reset();
        ircService = proxyquire("../../lib/irc-appservice.js", {
            "matrix-js-sdk": clientMock,
            "irc": ircMock
        });
        mockAsapiController = asapiMock.create();

        // do the init
        dbHelper._reset(sDatabaseUri).then(function() {
            ircService.configure(ircConfig);
            return ircService.register(mockAsapiController, serviceConfig);
        }).done(function() {
            done();
        });
    });

    it("should join 1:1 rooms invited from matrix", function(done) {
        var tUserId = "@flibble:wibble";
        var tIrcNick = "someone";
        var tUserLocalpart = sIrcServer+"_"+tIrcNick;
        var tIrcUserId = "@"+tUserLocalpart+":"+sHomeServerDomain;

        // there's a number of actions we want this to do, so track them to make
        // sure they are all called.
        var whoisDefer = q.defer();
        var registerDefer = q.defer();
        var joinRoomDefer = q.defer();
        var roomStateDefer = q.defer();
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
            room_id: sRoomId,
            type: "m.room.member"
        });

        // when it queries whois, say they exist
        ircMock._findClientAsync(sIrcServer, sBotNick).then(function(client) {
            return client._triggerConnect();
        }).then(function(client) {
            return client._triggerWhois(tIrcNick, true);
        }).done(function() {
            whoisDefer.resolve();
        });

        // when it tries to register, join the room and get state, accept them
        var sdk = clientMock._client();
        sdk.register.andCallFake(function(loginType, data) {
            expect(loginType).toEqual("m.login.application_service");
            expect(data).toEqual({
                user: tUserLocalpart
            });
            registerDefer.resolve();
            return q({
                user_id: tIrcUserId
            });
        });
        sdk.joinRoom.andCallFake(function(roomId) {
            expect(roomId).toEqual(sRoomId);
            joinRoomDefer.resolve();
            return q({});
        });
        sdk.roomState.andCallFake(function(roomId) {
            expect(roomId).toEqual(sRoomId);
            roomStateDefer.resolve({});
            return q([
            {
                content: {membership: "join"},
                user_id: tIrcUserId,
                state_key: tIrcUserId,
                room_id: sRoomId,
                type: "m.room.member"
            },
            {
                content: {membership: "join"},
                user_id: tUserId,
                state_key: tUserId,
                room_id: sRoomId,
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
        done();
    });
});

describe("IRC-to-Matrix PMing", function() {
    var ircService = null;
    var mockAsapiController = null;
    var sdk = null;

    var tRealIrcUserNick = "bob";
    var tVirtualUserId = "@"+sIrcServer+"_"+tRealIrcUserNick+":"+sHomeServerDomain;

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
        sdk.register.andCallFake(function(loginType, data) {
            expect(loginType).toEqual("m.login.application_service");
            expect(data).toEqual({
                user: sIrcServer+"_"+tRealIrcUserNick
            });
            return q({
                user_id: tVirtualUserId
            });
        });

        // do the init
        dbHelper._reset(sDatabaseUri).then(function() {
            ircService.configure(ircConfig);
            return ircService.register(mockAsapiController, serviceConfig);
        }).then(function() {
            // send a message in the linked room (so the service provisions a 
            // virtual IRC user which the 'real' IRC users can speak to)
            mockAsapiController._trigger("type:m.room.message", {
                content: {
                    body: "get me in",
                    msgtype: "m.text"
                },
                user_id: tRealUserId,
                room_id: sRoomId,
                type: "m.room.message"
            });
            return ircMock._findClientAsync(sIrcServer, tRealUserLocalpart);
        }).then(function(client) {
            return client._triggerConnect();
        }).then(function(client) {
            return client._triggerJoinFor(sChannel);
        }).done(function(client) {
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
        ircMock._findClientAsync(sIrcServer, tRealUserLocalpart).done(function(client) {
            client._trigger("message", [tRealIrcUserNick, tRealUserLocalpart, tText]);
        });
    });
});