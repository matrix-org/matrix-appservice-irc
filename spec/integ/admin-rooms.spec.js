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

    beforeEach(test.coroutine(function*() {
        yield test.beforeEach(env);

        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );
        env.ircMock._autoJoinChannels(
            roomMapping.server, roomMapping.botNick, roomMapping.channel
        );

        yield test.initEnv(env);
    }));

    afterEach(test.coroutine(function*() {
        yield test.afterEach(env);
    }));

    it("should be possible by sending an invite to the bot's user ID",
    test.coroutine(function*() {
        var botJoinedRoom = false;
        var sdk = env.clientMock._client(botUserId);
        sdk.joinRoom.and.callFake(function(roomId) {
            expect(roomId).toEqual("!adminroomid:here");
            botJoinedRoom = true;
            return Promise.resolve({});
        });

        yield env.mockAppService._trigger("type:m.room.member", {
            content: {
                membership: "invite",
            },
            state_key: botUserId,
            user_id: "@someone:somewhere",
            room_id: "!adminroomid:here",
            type: "m.room.member"
        });
        expect(botJoinedRoom).toBe(true);
    }));
});

describe("Admin rooms", function() {
    var adminRoomId = "!adminroomid:here";
    var userId = "@someone:somewhere";
    var userIdNick = "M-someone";

    beforeEach(test.coroutine(function*() {
        yield test.beforeEach(env);

        // enable syncing
        config.ircService.servers[config._server].membershipLists.enabled = true;
        config.ircService.servers[
            config._server
        ].membershipLists.global.matrixToIrc.incremental = true;

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
        sdk.joinRoom.and.callFake(function(roomId) {
            expect([adminRoomId, roomMapping.roomId]).toContain(roomId);
            return Promise.resolve({});
        });

        jasmine.clock().install();

        yield test.initEnv(env, config).then(function() {
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
        });
    }));

    afterEach(test.coroutine(function*() {
        jasmine.clock().uninstall();
        yield test.afterEach(env);
    }));

    it("should respond to bad !nick commands with a help notice",
    test.coroutine(function*() {
        var sentNotice = false;
        var sdk = env.clientMock._client(botUserId);
        sdk.sendEvent.and.callFake(function(roomId, type, content) {
            expect(roomId).toEqual(adminRoomId);
            expect(content.msgtype).toEqual("m.notice");
            sentNotice = true;
            return Promise.resolve();
        });

        yield env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "!nick blargle wargle",
                msgtype: "m.text"
            },
            user_id: userId,
            room_id: adminRoomId,
            type: "m.room.message"
        });
        expect(sentNotice).toBe(true);
    }));

    it("should respond to bad !join commands with a help notice",
    test.coroutine(function*() {
        var sentNotice = false;
        var sdk = env.clientMock._client(botUserId);
        sdk.sendEvent.and.callFake(function(roomId, type, content) {
            expect(roomId).toEqual(adminRoomId);
            expect(content.msgtype).toEqual("m.notice");
            sentNotice = true;
            return Promise.resolve();
        });

        yield env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "!join blargle",
                msgtype: "m.text"
            },
            user_id: userId,
            room_id: adminRoomId,
            type: "m.room.message"
        })
        expect(sentNotice).toBe(true);
    }));

    it("should ignore messages sent by the bot", test.coroutine(function*() {
        yield env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "!join blargle",
                msgtype: "m.text"
            },
            user_id: botUserId,
            room_id: adminRoomId,
            type: "m.room.message"
        });
    }));

    it("should be able to change their nick using !nick",
    test.coroutine(function*() {
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
        sdk.sendEvent.and.callFake(function(roomId, type, content) {
            expect(roomId).toEqual(adminRoomId);
            expect(content.msgtype).toEqual("m.notice");
            sentAckNotice = true;
            return Promise.resolve();
        });

        // trigger the request to change the nick
        yield env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "!nick " + roomMapping.server + " " + newNick,
                msgtype: "m.text"
            },
            user_id: userId,
            room_id: adminRoomId,
            type: "m.room.message"
        });
        // trigger the message which should use the new nick
        yield env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: testText,
                msgtype: "m.text"
            },
            user_id: userId,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        });

        // make sure everything was called
        expect(sentNickCommand).toBe(true, "sent nick IRC command");
        expect(sentAckNotice).toBe(true, "sent ACK m.notice");
        expect(sentSay).toBe(true, "sent say IRC command");
    }));

    it("should be able to change their nick using !nick and have it persist across disconnects",
    test.coroutine(function*() {
        var newNick = "Blurple";
        var testText = "I don't know what colour I am.";
        // we will be disconnecting the user so we want to accept incoming connects/joins
        // as the new nick.
        env.ircMock._autoConnectNetworks(
            roomMapping.server, newNick, roomMapping.server
        );
        env.ircMock._autoJoinChannels(
            roomMapping.server, newNick, roomMapping.channel
        );

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
        var sdk = env.clientMock._client(botUserId);
        sdk.sendEvent.and.callFake(function(roomId, type, content) {
            return Promise.resolve();
        });

        // trigger the request to change the nick
        yield env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "!nick " + roomMapping.server + " " + newNick,
                msgtype: "m.text"
            },
            user_id: userId,
            room_id: adminRoomId,
            type: "m.room.message"
        });

        // disconnect the user
        var cli = yield env.ircMock._findClientAsync(roomMapping.server, newNick);
        cli.emit("error", {command: "err_testsezno"});

        // wait a bit for reconnect timers
        setImmediate(function() {
            jasmine.clock().tick(1000 * 11);
        });


        // trigger the message which should use the new nick
        yield env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: testText,
                msgtype: "m.text"
            },
            user_id: userId,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        });

        // make sure everything was called
        expect(sentNickCommand).toBe(true, "Client did not send nick IRC command");
        expect(sentSay).toBe(true, "Client did not send message as new nick");
    }));

    it("should be able to change their nick using !nick and have it persist " +
        "when changing the display name",
        test.coroutine(function*() {
            var newNick = "Blurple";
            var displayName = "Durple";

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

            // make sure that a display name change is not propagated
            var sentNick = false;
            env.ircMock._whenClient(roomMapping.server, newNick, "send",
                function(client, channel, text) {
                    sentNick = true;
                });

            // trigger the request to change the nick
            yield env.mockAppService._trigger("type:m.room.message", {
                content: {
                    body: "!nick " + roomMapping.server + " " + newNick,
                    msgtype: "m.text"
                },
                user_id: userId,
                room_id: adminRoomId,
                type: "m.room.message"
            });

            // trigger a display name change
            yield env.mockAppService._trigger("type:m.room.member", {
                content: {
                    membership: "join",
                    avatar_url: null,
                    displayname: displayName
                },
                state_key: userId,
                user_id: userId,
                room_id: roomMapping.roomId,
                type: "m.room.member",
            });

            // make sure everything was called
            expect(sentNickCommand).toBe(true, "sent nick IRC command");
            expect(sentNick).toBe(false, "sent nick IRC command on displayname change");
        }));

    it("should propagate a display name change as a nick change when no custom nick is set",
    test.coroutine(function*() {
        var newNick = "Blurple";

        // make sure that the nick command is sent
        var sentNickCommand = false;
        env.ircMock._whenClient(roomMapping.server, userIdNick, "send",
            function(client, command, arg) {
                expect(client.nick).toEqual(userIdNick, "use the old nick on /nick");
                expect(client.addr).toEqual(roomMapping.server);
                expect(command).toEqual("NICK");
                expect(arg).toEqual('M-' + newNick);
                sentNickCommand = true;
            });

        // trigger a display name change
        yield env.mockAppService._trigger("type:m.room.member", {
            content: {
                membership: "join",
                avatar_url: null,
                displayname: newNick
            },
            state_key: userId,
            user_id: userId,
            room_id: roomMapping.roomId,
            type: "m.room.member",
        });

        // make sure everything was called
        expect(sentNickCommand).toBe(true, "sent nick IRC command");
    }));

    it("should reject !nick changes for IRC errors",
    test.coroutine(function*() {
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
            client.emit("error", {
                commandType: "error",
                command: "err_nicktoofast"
            })
            sentNickCommand = true;
        });

        // make sure that when a message is sent it uses the old nick
        var sentSay = false;
        env.ircMock._whenClient(roomMapping.server, userIdNick, "say",
        function(client, channel, text) {
            expect(client.nick).toEqual(userIdNick, "use the new nick on /say");
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
        sdk.sendEvent.and.callFake(function(roomId, type, content) {
            expect(roomId).toEqual(adminRoomId);
            expect(content.msgtype).toEqual("m.notice");
            expect(content.body.indexOf("err_nicktoofast")).not.toEqual(-1);
            sentAckNotice = true;
            return Promise.resolve();
        });

        // trigger the request to change the nick
        yield env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "!nick " + roomMapping.server + " " + newNick,
                msgtype: "m.text"
            },
            user_id: userId,
            room_id: adminRoomId,
            type: "m.room.message"
        });
        // trigger the message which should use the OLD nick
        yield env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: testText,
                msgtype: "m.text"
            },
            user_id: userId,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        });

        // make sure everything was called
        expect(sentNickCommand).toBe(true, "sent nick IRC command");
        expect(sentAckNotice).toBe(true, "sent ACK m.notice");
        expect(sentSay).toBe(true, "sent say IRC command");
    }));

    it("should timeout !nick changes after 10 seconds", test.coroutine(function*() {
        var newNick = "Blurple";

        // make sure that the NICK command is sent
        var sentNickCommand = false;
        env.ircMock._whenClient(roomMapping.server, userIdNick, "send",
        function(client, command, arg) {
            expect(client.nick).toEqual(userIdNick, "use the old nick on /nick");
            expect(client.addr).toEqual(roomMapping.server);
            expect(command).toEqual("NICK");
            expect(arg).toEqual(newNick);
            // don't emit anything.. and speed up time
            setImmediate(function() {
                jasmine.clock().tick(1000 * 11);
            });

            sentNickCommand = true;
        });

        // make sure the AS sends a timeout error as a notice in the admin
        // room
        var sentAckNotice = false;
        var sdk = env.clientMock._client(botUserId);
        sdk.sendEvent.and.callFake(function(roomId, type, content) {
            expect(roomId).toEqual(adminRoomId);
            expect(content.msgtype).toEqual("m.notice");
            expect(content.body.indexOf("Timed out")).not.toEqual(-1);
            sentAckNotice = true;
            return Promise.resolve();
        });

        // trigger the request to change the nick
        yield env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "!nick " + roomMapping.server + " " + newNick,
                msgtype: "m.text"
            },
            user_id: userId,
            room_id: adminRoomId,
            type: "m.room.message"
        });

        // make sure everything was called
        expect(sentNickCommand).toBe(true, "sent nick IRC command");
        expect(sentAckNotice).toBe(true, "sent ACK m.notice");
    }));

    it("should be able to join a channel with !join if they are on the whitelist",
    test.coroutine(function*() {
        var newChannel = "#awooga";
        var newRoomId = "!aasifuhawei:efjkwehfi";
        var serverConfig = env.config.ircService.servers[roomMapping.server];
        var serverShouldPublishRooms = serverConfig.dynamicChannels.published;
        var serverJoinRule = serverConfig.dynamicChannels.joinRule;

        // let the bot join the irc channel
        var joinedChannel = false;
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "join",
        function(client, chan, cb) {
            if (chan === newChannel) {
                joinedChannel = true;
                if (cb) { cb(); }
            }
        });

        // let the user join the IRC channel because of membership syncing
        env.ircMock._whenClient(roomMapping.server, userIdNick, "join",
        function(client, chan, cb) {
            if (chan === newChannel && cb) { cb(); }
        });

        // make sure the AS creates a new PRIVATE matrix room.
        var createdMatrixRoom = false;
        var sdk = env.clientMock._client(botUserId);
        sdk.createRoom.and.callFake(function(opts) {
            expect(opts.visibility).toEqual(serverShouldPublishRooms ? "public" : "private");
            expect(
                opts.initial_state.find(
                    (s)=> s.type === 'm.room.join_rules'
                ).content.join_rule
            ).toEqual(serverJoinRule);
            expect(opts.invite).toEqual([userId]);
            createdMatrixRoom = true;
            return Promise.resolve({
                room_id: newRoomId
            });
        });

        // trigger the request to join a channel
        yield env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "!join " + roomMapping.server + " " + newChannel,
                msgtype: "m.text"
            },
            user_id: userId,
            room_id: adminRoomId,
            type: "m.room.message"
        });

        // make sure everything was called
        expect(createdMatrixRoom).toBe(true, "Did not create matrix room");
        expect(joinedChannel).toBe(true, "Bot didn't join channel");
    }));

    it("should be able to join a channel with !join and a key",
    test.coroutine(function*() {
        var newChannel = "#awooga";
        var newRoomId = "!aasifuhawei:efjkwehfi";
        var key = "secret";
        var serverConfig = env.config.ircService.servers[roomMapping.server];
        var serverShouldPublishRooms = serverConfig.dynamicChannels.published;
        var serverJoinRule = serverConfig.dynamicChannels.joinRule;

        // let the bot join the irc channel
        var joinedChannel = false;
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "join",
        function(client, chan, cb) {
            if (chan === (newChannel + " " + key)) {
                joinedChannel = true;
                if (cb) { cb(); }
            }
        });

        // Because we gave a key, we expect the user to be joined (with the key)
        // immediately.
        env.ircMock._whenClient(roomMapping.server, userIdNick, "join",
        function(client, chan, cb) {
            if (chan === (newChannel + " " + key)) {
                joinedChannel = true;
                if (cb) { cb(); }
            }
        });

        // make sure the AS creates a new PRIVATE matrix room.
        var createdMatrixRoom = false;
        var sdk = env.clientMock._client(botUserId);
        sdk.createRoom.and.callFake(function(opts) {
            expect(opts.visibility).toEqual(serverShouldPublishRooms ? "public" : "private");
            expect(
                opts.initial_state.find(
                    (s)=> s.type === 'm.room.join_rules'
                ).content.join_rule
            ).toEqual(serverJoinRule);
            expect(opts.invite).toEqual([userId]);
            createdMatrixRoom = true;
            return Promise.resolve({
                room_id: newRoomId
            });
        });

        // trigger the request to join a channel
        yield env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "!join " + roomMapping.server + " " + newChannel + " " + key,
                msgtype: "m.text"
            },
            user_id: userId,
            room_id: adminRoomId,
            type: "m.room.message"
        })

        // make sure everything was called
        expect(createdMatrixRoom).toBe(true, "Did not create matrix room");
        expect(joinedChannel).toBe(true, "Bot didn't join channel");
    }));

    it("should allow arbitrary IRC commands to be issued",
    test.coroutine(function*() {
        var newChannel = "#coffee";

        // Expect the following commands to be sent in order
        let recvCommands = ["JOIN", "TOPIC", "PART", "STUPID"];

        var cmdIx = 0;
        env.ircMock._whenClient(roomMapping.server, userIdNick, "send",
        function(client) {
            let args = Array.from(arguments).splice(1);
            let keyword = args[0];

            expect(keyword).toBe(recvCommands[cmdIx]);
            cmdIx++;
        });

        // 5 commands should be executed
        // rubbishserver should not be accepted
        let commands = [
            `!cmd ${roomMapping.server} JOIN ${newChannel}`,
            `!cmd ${roomMapping.server} TOPIC ${newChannel} :some new fancy topic`,
            `!cmd ${roomMapping.server} PART ${newChannel}`,
            `!cmd ${roomMapping.server} STUPID COMMANDS`,
            `!cmd rubbishserver SOME COMMAND`];

        for (var i = 0; i < commands.length; i++) {
            // send commands
            yield env.mockAppService._trigger("type:m.room.message", {
                content: {
                    body: commands[i],
                    msgtype: "m.text"
                },
                user_id: userId,
                room_id: adminRoomId,
                type: "m.room.message"
            });
        }

        expect(cmdIx).toBe(recvCommands.length);
    }));

    it("should allow arbitrary IRC commands to be issued when server has not been set",
    test.coroutine(function*() {
        var newChannel = "#coffee";

        // Expect the following commands to be sent in order
        let recvCommands = ["JOIN", "TOPIC", "PART", "STUPID"];

        var cmdIx = 0;
        env.ircMock._whenClient(roomMapping.server, userIdNick, "send",
        function(client) {
            let args = Array.from(arguments).splice(1);
            let keyword = args[0];

            expect(keyword).toBe(recvCommands[cmdIx]);
            cmdIx++;
        });

        let commands = [
            `!cmd JOIN ${newChannel}`,
            `!cmd TOPIC ${newChannel} :some new fancy topic`,
            `!cmd PART ${newChannel}`,
            `!cmd STUPID COMMANDS`];

        for (var i = 0; i < commands.length; i++) {
            // send commands
            yield env.mockAppService._trigger("type:m.room.message", {
                content: {
                    body: commands[i],
                    msgtype: "m.text"
                },
                user_id: userId,
                room_id: adminRoomId,
                type: "m.room.message"
            });
        }

        expect(cmdIx).toBe(recvCommands.length);
    }));

    it("should reject malformed commands (new form)",
    test.coroutine(function*() {
        var cmdCount = 0;
        env.ircMock._whenClient(roomMapping.server, userIdNick, "send",
        function(client) {
            cmdCount++;
        });

        let command = `!cmd M4LF0RM3D command`;

        // send command
        yield env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: command,
                msgtype: "m.text"
            },
            user_id: userId,
            room_id: adminRoomId,
            type: "m.room.message"
        });

        expect(cmdCount).toBe(0);
    }));

    it("should reject PROTOCTL commands",
    test.coroutine(function*() {
        var cmdCount = 0;
        env.ircMock._whenClient(roomMapping.server, userIdNick, "send",
        function(client) {
            cmdCount++;
        });

        let command = `!cmd PROTOCTL command`;

        // send command
        yield env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: command,
                msgtype: "m.text"
            },
            user_id: userId,
            room_id: adminRoomId,
            type: "m.room.message"
        });

        expect(cmdCount).toBe(0);
    }));

    it("mx bot should be kicked when there are > 2 users in room and a message is sent",
    test.coroutine(function*() {

        var sdk = env.clientMock._client(botUserId);
        sdk.roomState.and.callFake(
            function (roomId) {
                expect(roomId).toBe(adminRoomId, 'Room state returned should be for admin room');
                return Promise.resolve([
                    {
                        content: {membership: "join"},
                        type: "m.room.member",
                        state_key: "fake bot state"
                    },
                    {
                        content: {membership: "join"},
                        type: "m.room.member",
                        state_key: "fake user1 state"
                    },
                    {content:
                        {membership: "join"},
                        type: "m.room.member",
                        state_key: "fake user2 state"
                    }
                ]);
            }
        );

        var botLeft = false
        sdk.leave.and.callFake(function(roomId) {
            expect(roomId).toBe(adminRoomId, 'Bot did not leave admin room');
            botLeft = true;
            return Promise.resolve();
        });

        yield env.mockAppService._trigger("type:m.room.member", {
            content: {
                membership: "join",
            },
            state_key: botUserId,
            user_id: "@user1:localhost",
            room_id: adminRoomId,
            type: "m.room.member"
        });

        yield env.mockAppService._trigger("type:m.room.member", {
            content: {
                membership: "join",
            },
            state_key: botUserId,
            user_id: "@user2:localhost",
            room_id: adminRoomId,
            type: "m.room.member"
        });

        // trigger the bot to leave
        yield env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "ping",
                msgtype: "m.text"
            },
            user_id: "@user2:localhost",
            room_id: adminRoomId,
            type: "m.room.message"
        }).then(
            () => {
                expect(botLeft).toBe(true);
            },
            (err) => {console.log(err)}
        );
    }));

    it("mx bot should NOT be kicked when there are 2 users in room and a message is sent",
    test.coroutine(function*() {

        var sdk = env.clientMock._client(botUserId);
        sdk.roomState.and.callFake(
            function (roomId) {
                expect(roomId).toBe(adminRoomId, 'Room state returned should be for admin room');
                return Promise.resolve([
                    {content: {membership: "join"}, type: "m.room.member", state_key: ":)"},
                    {content: {membership: "join"}, type: "m.room.member", state_key: ";)"}
                ]);
            }
        );

        var botLeft = false
        sdk.leave.and.callFake(function(roomId) {
            expect(roomId).toBe(adminRoomId, 'Bot did not leave admin room');
            botLeft = true;
            return Promise.resolve();
        });

        yield env.mockAppService._trigger("type:m.room.member", {
            content: {
                membership: "join",
            },
            state_key: botUserId,
            user_id: "@user1:localhost",
            room_id: adminRoomId,
            type: "m.room.member"
        });

        // trigger the bot to leave
        yield env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "ping",
                msgtype: "m.text"
            },
            user_id: "@user2:localhost",
            room_id: adminRoomId,
            type: "m.room.message"
        }).then(
            () => {
                expect(botLeft).toBe(false);
            },
            (err) => {console.log(err)}
        );
    }));
});
