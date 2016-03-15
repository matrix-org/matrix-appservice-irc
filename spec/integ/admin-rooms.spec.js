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
var botUserId = config._botUserId;

describe("Creating admin rooms", function() {

    beforeEach(function(done) {
        test.beforeEach(this, env); // eslint-disable-line no-invalid-this

        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );
        env.ircMock._autoJoinChannels(
            roomMapping.server, roomMapping.botNick, roomMapping.channel
        );

        test.initEnv(env).done(function() {
            done();
        });
    });

    it("should be possible by sending an invite to the bot's user ID",
    function(done) {
        var botJoinedRoom = false;
        var sdk = env.clientMock._client(botUserId);
        sdk.joinRoom.andCallFake(function(roomId) {
            expect(roomId).toEqual("!adminroomid:here");
            botJoinedRoom = true;
            return Promise.resolve({});
        });

        env.mockAppService._trigger("type:m.room.member", {
            content: {
                membership: "invite",
            },
            state_key: botUserId,
            user_id: "@someone:somewhere",
            room_id: "!adminroomid:here",
            type: "m.room.member"
        }).done(function(e) {
            expect(botJoinedRoom).toBe(true);
            done();
        });
    });
});

describe("Admin rooms", function() {
    var adminRoomId = "!adminroomid:here";
    var userId = "@someone:somewhere";
    var userIdNick = "M-someone";

    beforeEach(function(done) {
        test.beforeEach(this, env); // eslint-disable-line no-invalid-this

        // enable nick changes
        config.ircService.servers[roomMapping.server].ircClients.allowNickChanges = true;
        // enable private dynamic channels with the user ID in a whitelist
        config.ircService.servers[roomMapping.server].dynamicChannels.enabled = true;
        config.ircService.servers[roomMapping.server].dynamicChannels.whitelist = [
            userId
        ];
        config.ircService.servers[roomMapping.server].dynamicChannels.joinRule = "invite";
        config.ircService.servers[roomMapping.server].dynamicChannels.published = false;
        config.ircService.servers[roomMapping.server].dynamicChannels.createAlias = false;

        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );
        env.ircMock._autoJoinChannels(
            roomMapping.server, roomMapping.botNick, roomMapping.channel
        );
        env.ircMock._autoConnectNetworks(
            roomMapping.server, userIdNick, roomMapping.server
        );
        env.ircMock._autoJoinChannels(
            roomMapping.server, userIdNick, roomMapping.channel
        );

        // auto-join an admin room
        var sdk = env.clientMock._client(userId);
        sdk.joinRoom.andCallFake(function(roomId) {
            expect([adminRoomId, roomMapping.roomId]).toContain(roomId);
            return Promise.resolve({});
        });

        test.initEnv(env, config).then(function() {
            // auto-setup an admin room
            return env.mockAppService._trigger("type:m.room.member", {
                content: {
                    membership: "invite"
                },
                state_key: botUserId,
                user_id: userId,
                room_id: adminRoomId,
                type: "m.room.member"
            });
        }).then(function() {
            // send a message to register the userId on the IRC network
            return env.mockAppService._trigger("type:m.room.message", {
                content: {
                    body: "ping",
                    msgtype: "m.text"
                },
                user_id: userId,
                room_id: roomMapping.roomId,
                type: "m.room.message"
            });
        }).done(function() {
            done();
        });
    });

    it("should respond to bad !nick commands with a help notice",
    function(done) {
        var sentNotice = false;
        var sdk = env.clientMock._client(botUserId);
        sdk.sendEvent.andCallFake(function(roomId, type, content) {
            expect(roomId).toEqual(adminRoomId);
            expect(content.msgtype).toEqual("m.notice");
            sentNotice = true;
            return Promise.resolve();
        });

        env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "!nick blargle wargle",
                msgtype: "m.text"
            },
            user_id: userId,
            room_id: adminRoomId,
            type: "m.room.message"
        }).done(function() {
            expect(sentNotice).toBe(true);
            done();
        });
    });

    it("should respond to bad !join commands with a help notice",
    function(done) {
        var sentNotice = false;
        var sdk = env.clientMock._client(botUserId);
        sdk.sendEvent.andCallFake(function(roomId, type, content) {
            expect(roomId).toEqual(adminRoomId);
            expect(content.msgtype).toEqual("m.notice");
            sentNotice = true;
            return Promise.resolve();
        });

        env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "!join blargle",
                msgtype: "m.text"
            },
            user_id: userId,
            room_id: adminRoomId,
            type: "m.room.message"
        }).done(function() {
            expect(sentNotice).toBe(true);
            done();
        });
    });

    it("should ignore messages sent by the bot", function(done) {
        env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "!join blargle",
                msgtype: "m.text"
            },
            user_id: botUserId,
            room_id: adminRoomId,
            type: "m.room.message"
        }).catch(function(e) {
            done();
        });
    });

    it("should be able to change their nick using !nick", function(done) {
        var newNick = "Blurple";
        var testText = "I don't know what colour I am.";

        // make sure that the nick command is sent
        var sentNickCommand = false;
        env.ircMock._whenClient(roomMapping.server, userIdNick, "send",
        function(client, command, arg) {
            expect(client.nick).toEqual(userIdNick, "use the old nick on /nick");
            expect(client.addr).toEqual(roomMapping.server);
            expect(command).toEqual("NICK");
            expect(arg).toEqual(newNick);
            client._changeNick(userIdNick, newNick);
            sentNickCommand = true;
        });

        // make sure that when a message is sent it uses the new nick
        var sentSay = false;
        env.ircMock._whenClient(roomMapping.server, newNick, "say",
        function(client, channel, text) {
            expect(client.nick).toEqual(newNick, "use the new nick on /say");
            expect(client.addr).toEqual(roomMapping.server);
            expect(channel).toEqual(roomMapping.channel);
            expect(text.length).toEqual(testText.length);
            expect(text).toEqual(testText);
            sentSay = true;
        });

        // make sure the AS sends an ACK of the request as a notice in the admin
        // room
        var sentAckNotice = false;
        var sdk = env.clientMock._client(botUserId);
        sdk.sendEvent.andCallFake(function(roomId, type, content) {
            expect(roomId).toEqual(adminRoomId);
            expect(content.msgtype).toEqual("m.notice");
            sentAckNotice = true;
            return Promise.resolve();
        });

        // trigger the request to change the nick
        env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "!nick " + roomMapping.server + " " + newNick,
                msgtype: "m.text"
            },
            user_id: userId,
            room_id: adminRoomId,
            type: "m.room.message"
        }).then(function() {
            // trigger the message which should use the new nick
            return env.mockAppService._trigger("type:m.room.message", {
                content: {
                    body: testText,
                    msgtype: "m.text"
                },
                user_id: userId,
                room_id: roomMapping.roomId,
                type: "m.room.message"
            });
        }).done(function() {
            // make sure everything was called
            expect(sentNickCommand).toBe(true, "sent nick IRC command");
            expect(sentAckNotice).toBe(true, "sent ACK m.notice");
            expect(sentSay).toBe(true, "sent say IRC command");
            done();
        });
    });

    it("should be able to join a channel with !join if they are on the whitelist",
    function(done) {
        var newChannel = "#awooga";
        var newRoomId = "!aasifuhawei:efjkwehfi";

        // let the bot join the irc channel
        var joinedChannel = false;
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "join",
        function(client, chan, cb) {
            if (chan === newChannel) {
                joinedChannel = true;
                if (cb) { cb(); }
            }
        });

        // make sure the AS creates a new PRIVATE matrix room.
        var createdMatrixRoom = false;
        var sdk = env.clientMock._client(botUserId);
        sdk.createRoom.andCallFake(function(opts) {
            expect(opts.visibility).toEqual("private");
            expect(opts.invite).toEqual([userId]);
            createdMatrixRoom = true;
            return Promise.resolve({
                room_id: newRoomId
            });
        });

        // trigger the request to join a channel
        env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "!join " + roomMapping.server + " " + newChannel,
                msgtype: "m.text"
            },
            user_id: userId,
            room_id: adminRoomId,
            type: "m.room.message"
        }).done(function() {
            // make sure everything was called
            expect(createdMatrixRoom).toBe(true, "Did not create matrix room");
            expect(joinedChannel).toBe(true, "Bot didn't join channel");
            done();
        });
    });
});
