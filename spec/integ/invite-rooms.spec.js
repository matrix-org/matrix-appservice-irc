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

describe("Invite-only rooms", function() {
    var botUserId = config._botUserId;
    var testUser = {
        id: "@flibble:wibble",
        nick: "flibble"
    };
    var testIrcUser = {
        localpart: roomMapping.server + "_foobar",
        id: "@" + roomMapping.server + "_foobar:" + config.homeserver.domain,
        nick: "foobar"
    };

    beforeEach(function(done) {
        test.beforeEach(this, env); // eslint-disable-line no-invalid-this

        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );

        // do the init
        test.initEnv(env).done(function() {
            done();
        });
    });

    it("should be joined by the bot if the AS does know the room ID",
    function(done) {
        var adminRoomId = "!adminroom:id";
        var sdk = env.clientMock._client(botUserId);
        var joinRoomCount = 0;
        sdk.joinRoom.andCallFake(function(roomId) {
            expect(roomId).toEqual(adminRoomId);
            joinRoomCount += 1;
            return Promise.resolve({});
        });

        env.mockAppService._trigger("type:m.room.member", {
            content: {
                membership: "invite",
            },
            state_key: botUserId,
            user_id: testUser.id,
            room_id: adminRoomId,
            type: "m.room.member"
        }).then(function() {
            expect(joinRoomCount).toEqual(1, "Failed to join admin room");
            // inviting them AGAIN to an existing known ADMIN room should trigger a join
            return env.mockAppService._trigger("type:m.room.member", {
                content: {
                    membership: "invite",
                },
                state_key: botUserId,
                user_id: testUser.id,
                room_id: adminRoomId,
                type: "m.room.member"
            });
        }).done(function() {
            expect(joinRoomCount).toEqual(2, "Failed to join admin room again");
            done();
        }, function(err) {
            expect(true).toBe(false, "Failed to join admin room again: " + err);
            done();
        });
    });

    it("should be joined by a virtual IRC user if the bot invited them, " +
        "regardless of the number of people in the room.",
    function(done) {
        // when it queries whois, say they exist
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "whois",
        function(client, nick, cb) {
            expect(nick).toEqual(testIrcUser.nick);
            // say they exist (presence of user key)
            cb({
                user: testIrcUser.nick,
                nick: testIrcUser.nick
            });
        });

        var sdk = env.clientMock._client(testIrcUser.id);
        // if it tries to register, accept.
        sdk._onHttpRegister({
            expectLocalpart: testIrcUser.localpart,
            returnUserId: testIrcUser.id
        });

        var joinedRoom = false;
        sdk.joinRoom.andCallFake(function(roomId) {
            expect(roomId).toEqual(roomMapping.roomId);
            joinedRoom = true;
            return Promise.resolve({});
        });

        var leftRoom = false;
        sdk.leave.andCallFake(function(roomId) {
            expect(roomId).toEqual(roomMapping.roomId);
            leftRoom = true;
            return Promise.resolve({});
        });

        var askedForRoomState = false;
        sdk.roomState.andCallFake(function(roomId) {
            expect(roomId).toEqual(roomMapping.roomId);
            askedForRoomState = true;
            return Promise.resolve([
            {
                content: {membership: "join"},
                user_id: botUserId,
                state_key: botUserId,
                room_id: roomMapping.roomId,
                type: "m.room.member"
            },
            {
                content: {membership: "join"},
                user_id: testIrcUser.id,
                state_key: testIrcUser.id,
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

        env.mockAppService._trigger("type:m.room.member", {
            content: {
                membership: "invite",
            },
            state_key: testIrcUser.id,
            user_id: botUserId,
            room_id: roomMapping.roomId,
            type: "m.room.member"
        }).then(function() {
            expect(joinedRoom).toBe(true);
            expect(leftRoom).toBe(false);
            // should go off the fact that the inviter was the bot
            expect(askedForRoomState).toBe(false);
            done();
        });
    });
});
