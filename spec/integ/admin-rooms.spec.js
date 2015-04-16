"use strict";
var q = require("q");
var test = require("../util/test");

// set up integration testing mocks
var env = test.mkEnv();

// set up test config
var appConfig = env.appConfig;
var roomMapping = appConfig.roomMapping;

describe("Creating admin rooms", function() {
    var botUserId = "@"+appConfig.botLocalpart+":"+appConfig.homeServerDomain;

    beforeEach(function(done) {
        test.beforeEach(this, env);

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
        var sdk = env.clientMock._client();
        sdk.joinRoom.andCallFake(function(roomId) {
            expect(roomId).toEqual("!adminroomid:here");
            botJoinedRoom = true;
            return q({});
        });

        env.mockAsapiController._trigger("type:m.room.member", {
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
    var sdk = null;

    var adminRoomId = "!adminroomid:here";
    var userId = "@someone:somewhere";
    var userIdNick = "M-someone";
    var botUserId = "@"+appConfig.botLocalpart+":"+appConfig.homeServerDomain;

    // enable nick changes
    appConfig.ircConfig.servers[roomMapping.server].ircClients.allowNickChanges = true;
    // enable private dynamic channels with the user ID in a whitelist
    appConfig.ircConfig.servers[roomMapping.server].dynamicChannels.enabled = true;
    appConfig.ircConfig.servers[roomMapping.server].dynamicChannels.whitelist = [
        userId
    ];
    appConfig.ircConfig.servers[roomMapping.server].dynamicChannels.visibility = "private";

    beforeEach(function(done) {
        test.beforeEach(this, env);

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
        sdk = env.clientMock._client();
        sdk.joinRoom.andCallFake(function(roomId) {
            expect(roomId).toEqual(adminRoomId);
            return q({});
        });

        // do the init
        env.dbHelper._reset(appConfig.databaseUri).then(function() {
            env.ircService.configure(appConfig.ircConfig);
            return env.ircService.register(
                env.mockAsapiController, appConfig.serviceConfig
            );
        }).then(function() {
            // auto-setup an admin room
            return env.mockAsapiController._trigger("type:m.room.member", {
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
            return env.mockAsapiController._trigger("type:m.room.message", {
                content: {
                    body: "ping",
                    msgtype: "m.text"
                },
                user_id: userId,
                room_id: roomMapping.roomId,
                type: "m.room.message"
            });
        }).done(function() {
            console.log("Before each done");
            done();
        });
        console.log("Before each post");
    });

    it("should respond to bad !nick commands with a help notice", function(done) {
        var sentNotice = false;
        sdk.sendMessage.andCallFake(function(roomId, content) {
            expect(roomId).toEqual(adminRoomId);
            expect(content.msgtype).toEqual("m.notice");
            sentNotice = true;
            return q();
        });

        env.mockAsapiController._trigger("type:m.room.message", {
            content: {
                body: "!nick blargle",
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

    it("should respond to bad !join commands with a help notice", function(done) {
        var sentNotice = false;
        sdk.sendMessage.andCallFake(function(roomId, content) {
            expect(roomId).toEqual(adminRoomId);
            expect(content.msgtype).toEqual("m.notice");
            sentNotice = true;
            return q();
        });

        env.mockAsapiController._trigger("type:m.room.message", {
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
        env.mockAsapiController._trigger("type:m.room.message", {
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

        // make sure the AS sends an ACK of the request as a notice in the admin room
        var sentAckNotice = false;
        sdk.sendMessage.andCallFake(function(roomId, content) {
            expect(roomId).toEqual(adminRoomId);
            expect(content.msgtype).toEqual("m.notice");
            sentAckNotice = true;
            return q();
        });

        // trigger the request to change the nick
        env.mockAsapiController._trigger("type:m.room.message", {
            content: {
                body: "!nick "+roomMapping.server+" "+newNick,
                msgtype: "m.text"
            },
            user_id: userId,
            room_id: adminRoomId,
            type: "m.room.message"
        }).then(function() {
            // trigger the message which should use the new nick
            return env.mockAsapiController._trigger("type:m.room.message", {
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
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "join",
        function(client, chan, cb) {
            expect(chan).toEqual(newChannel);
            if (cb) { cb(); }
        });

        // make sure the AS creates a new PRIVATE matrix room.
        var createdMatrixRoom = false;
        sdk.createRoom.andCallFake(function(opts) {
            expect(opts.visibility).toEqual("private");
            createdMatrixRoom = true;
            return q({
                room_id: newRoomId
            });
        });

        // make sure the AS invites the user to the new room
        var sentInvite = false;
        sdk.invite.andCallFake(function(roomId, inviteeUserId) {
            expect(roomId).toEqual(newRoomId);
            expect(inviteeUserId).toEqual(userId);
            sentInvite = true;
            return q({
                room_id: newRoomId
            });
        });

        // trigger the request to join a channel
        env.mockAsapiController._trigger("type:m.room.message", {
            content: {
                body: "!join "+roomMapping.server+" "+newChannel,
                msgtype: "m.text"
            },
            user_id: userId,
            room_id: adminRoomId,
            type: "m.room.message"
        }).done(function() {
            // make sure everything was called
            expect(createdMatrixRoom).toBe(true, "created matrix room");
            expect(sentInvite).toBe(true, "sent matrix invite");
            done();
        });
    });
});