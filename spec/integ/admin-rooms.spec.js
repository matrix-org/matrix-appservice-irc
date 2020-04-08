const Promise = require("bluebird");
const envBundle = require("../util/env-bundle");

describe("Creating admin rooms", function() {
    const {env, roomMapping, botUserId, test} = envBundle();

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
        let botJoinedRoom = false;
        let sdk = env.clientMock._client(botUserId);
        sdk.joinRoom.and.callFake(function(roomId) {
            expect(roomId).toEqual("!adminroomid:here");
            botJoinedRoom = true;
            return Promise.resolve({});
        });

        yield env.mockAppService._trigger("type:m.room.member", {
            content: {
                membership: "invite",
                is_direct: true,
            },
            state_key: botUserId,
            user_id: "@someone:somewhere",
            room_id: "!adminroomid:here",
            type: "m.room.member"
        });
        expect(botJoinedRoom).toBe(true);
    }));

    it("should not create a room for a non is_direct invite",
    test.coroutine(function*() {
        let botJoinedRoom = false;
        let sdk = env.clientMock._client(botUserId);
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

        yield env.mockAppService._trigger("type:m.room.member", {
            content: {
                membership: "invite",
                is_direct: false,
            },
            state_key: botUserId,
            user_id: "@someone:somewhere",
            room_id: "!adminroomid:here",
            type: "m.room.member"
        });

        expect(botJoinedRoom).toBe(false);
    }));
});

describe("Admin rooms", function() {
    let adminRoomId = "!adminroomid:here";
    let userId = "@someone:somewhere";
    let userIdNick = "M-someone";

    const {env, config, roomMapping, botUserId, test} = envBundle();


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
        let sdk = env.clientMock._client(userId);
        sdk.joinRoom.and.callFake(function(roomId) {
            expect([adminRoomId, roomMapping.roomId]).toContain(roomId);
            return Promise.resolve({});
        });

        jasmine.clock().install();

        yield test.initEnv(env, config).then(function() {
            // auto-setup an admin room
            return env.mockAppService._trigger("type:m.room.member", {
                content: {
                    membership: "invite",
                    is_direct: true
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
        let sentNotice = false;
        let sdk = env.clientMock._client(botUserId);
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
        let sentNotice = false;
        let sdk = env.clientMock._client(botUserId);
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

    it("should respond to unknown commands with a notice",
    test.coroutine(function*() {
        let sentNotice = false;
        let sdk = env.clientMock._client(botUserId);
        sdk.sendEvent.and.callFake(function(roomId, type, content) {
            expect(roomId).toEqual(adminRoomId);
            expect(content.msgtype).toEqual("m.notice");
            sentNotice = true;
            return Promise.resolve();
        });

        yield env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "notacommand",
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
        let newNick = "Blurple";
        let testText = "I don't know what colour I am.";

        // make sure that the nick command is sent
        let sentNickCommand = false;
        env.ircMock._whenClient(roomMapping.server, userIdNick, "send",
        function(client, command, arg) {
            expect(client.nick).toEqual(userIdNick, "use the old nick on /nick");
            expect(client.addr).toEqual(roomMapping.server);
            expect(command).toEqual("NICK");
            expect(arg).toEqual(newNick);
            client._changeNick(userIdNick, newNick);
            sentNickCommand = true;
        });

        env.ircMock._whenClient(roomMapping.server, userIdNick, "whois", (client, whoisNick) => {
            expect(whoisNick).toEqual(newNick);
            client.emit("error", {
                commandType: "error",
                command: "err_nosuchnick",
                args: [undefined, newNick]
            });
        });

        // make sure that when a message is sent it uses the new nick
        let sentSay = false;
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
        let sentAckNotice = false;
        let sdk = env.clientMock._client(botUserId);
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
        let newNick = "Blurple";
        let testText = "I don't know what colour I am.";
        // we will be disconnecting the user so we want to accept incoming connects/joins
        // as the new nick.
        env.ircMock._autoConnectNetworks(
            roomMapping.server, newNick, roomMapping.server
        );
        env.ircMock._autoJoinChannels(
            roomMapping.server, newNick, roomMapping.channel
        );

        // make sure that the nick command is sent
        let sentNickCommand = false;
        env.ircMock._whenClient(roomMapping.server, userIdNick, "send",
        function(client, command, arg) {
            expect(client.nick).toEqual(userIdNick, "use the old nick on /nick");
            expect(client.addr).toEqual(roomMapping.server);
            expect(command).toEqual("NICK");
            expect(arg).toEqual(newNick);
            client._changeNick(userIdNick, newNick);
            sentNickCommand = true;
        });

        env.ircMock._whenClient(roomMapping.server, userIdNick, "whois", (client, whoisNick) => {
            expect(whoisNick).toEqual(newNick);
            client.emit("error", {
                commandType: "error",
                command: "err_nosuchnick",
                args: [undefined, newNick]
            });
        });

        // make sure that when a message is sent it uses the new nick
        let sentSay = false;
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
        let sdk = env.clientMock._client(botUserId);
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
        let cli = yield env.ircMock._findClientAsync(roomMapping.server, newNick);
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
            let newNick = "Blurple";
            let displayName = "Durple";

            // make sure that the nick command is sent
            let sentNickCommand = false;
            env.ircMock._whenClient(roomMapping.server, userIdNick, "send",
                function(client, command, arg) {
                    expect(client.nick).toEqual(userIdNick, "use the old nick on /nick");
                    expect(client.addr).toEqual(roomMapping.server);
                    expect(command).toEqual("NICK");
                    expect(arg).toEqual(newNick);
                    client._changeNick(userIdNick, newNick);
                    sentNickCommand = true;
                });

            env.ircMock._whenClient(roomMapping.server, userIdNick, "whois", (client, whoisNick) => {
                expect(whoisNick).toEqual(newNick);
                client.emit("error", {
                    commandType: "error",
                    command: "err_nosuchnick",
                    args: [undefined, newNick]
                });
            });

            // make sure that a display name change is not propagated
            let sentNick = false;
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
        let newNick = "Blurple";

        // make sure that the nick command is sent
        let sentNickCommand = false;
        env.ircMock._whenClient(roomMapping.server, userIdNick, "send",
            function(client, command, arg) {
                expect(client.nick).toEqual(userIdNick, "use the old nick on /nick");
                expect(client.addr).toEqual(roomMapping.server);
                expect(command).toEqual("NICK");
                expect(arg).toEqual('M-' + newNick);
                sentNickCommand = true;
            });

        env.ircMock._whenClient(roomMapping.server, userIdNick, "whois", (client, whoisNick) => {
            expect(whoisNick).toEqual('M-' + newNick);
            client.emit("error", {
                commandType: "error",
                command: "err_nosuchnick",
                args: [undefined, 'M-' + newNick]
            });
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
        let newNick = "Blurple";
        let testText = "I don't know what colour I am.";

        // make sure that the nick command is sent
        let sentNickCommand = false;
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

        env.ircMock._whenClient(roomMapping.server, userIdNick, "whois", (client, whoisNick) => {
            expect(whoisNick).toEqual(newNick);
            client.emit("error", {
                commandType: "error",
                command: "err_nosuchnick",
                args: [undefined, newNick]
            });
        });

        // make sure that when a message is sent it uses the old nick
        let sentSay = false;
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
        let sentAckNotice = false;
        let sdk = env.clientMock._client(botUserId);
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
        let newNick = "Blurple";

        // make sure that the NICK command is sent
        let sentNickCommand = false;
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

        env.ircMock._whenClient(roomMapping.server, userIdNick, "whois", (client, whoisNick) => {
            expect(whoisNick).toEqual(newNick);
            client.emit("error", {
                commandType: "error",
                command: "err_nosuchnick",
                args: [undefined, newNick]
            });
        });

        // make sure the AS sends a timeout error as a notice in the admin
        // room
        let sentAckNotice = false;
        let sdk = env.clientMock._client(botUserId);
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

    it("should not try to change to a nickname that is already in use", async () => {
        const newNick = "Blurple";

        // make sure that the NICK command not is sent
        let sentNickCommand = false;
        env.ircMock._whenClient(roomMapping.server, userIdNick, "send",
        function(client, command, arg) {
            expect(client.nick).toEqual(userIdNick, "use the old nick on /nick");
            expect(client.addr).toEqual(roomMapping.server);
            expect(command).toEqual("NICK");
            expect(arg).toEqual(newNick);
            sentNickCommand = true;
        });

        env.ircMock._whenClient(roomMapping.server, userIdNick, "whois", (client, whoisNick, callback) => {
            expect(whoisNick).toEqual(newNick);
            callback({user: {
                data: "hello"
            }, nick: whoisNick});
        });

        // make sure the AS sends a timeout error as a notice in the admin
        // room
        let sentAckNotice = false;
        const sdk = env.clientMock._client(botUserId);
        sdk.sendEvent.and.callFake(function(roomId, type, content) {
            expect(roomId).toEqual(adminRoomId);
            expect(content.msgtype).toEqual("m.notice");
            expect(content.body).not.toEqual(
                `The nickname ${newNick} is taken on ${roomMapping.server.domain}.` +
            "Please pick a different nick.");
            sentAckNotice = true;
            return Promise.resolve();
        });

        // trigger the request to change the nick
        await env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: `!nick ${roomMapping.server} ${newNick}`,
                msgtype: "m.text"
            },
            user_id: userId,
            room_id: adminRoomId,
            type: "m.room.message"
        });

        // make sure everything was called
        expect(sentNickCommand).toBe(false, "did not send nick IRC command");
        expect(sentAckNotice).toBe(true, "sent ACK m.notice");
    });

    it("should be able to join a channel with !join if they are on the whitelist",
    test.coroutine(function*() {
        let newChannel = "#awooga";
        let newRoomId = "!aasifuhawei:efjkwehfi";
        let serverConfig = env.config.ircService.servers[roomMapping.server];
        let serverShouldPublishRooms = serverConfig.dynamicChannels.published;
        let serverJoinRule = serverConfig.dynamicChannels.joinRule;

        // let the bot join the irc channel
        let joinedChannel = false;
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
        let createdMatrixRoom = false;
        let sdk = env.clientMock._client(botUserId);
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
        let newChannel = "#awooga";
        let newRoomId = "!aasifuhawei:efjkwehfi";
        let key = "secret";
        let serverConfig = env.config.ircService.servers[roomMapping.server];
        let serverShouldPublishRooms = serverConfig.dynamicChannels.published;
        let serverJoinRule = serverConfig.dynamicChannels.joinRule;

        // let the bot join the irc channel
        let joinedChannel = false;
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
        let createdMatrixRoom = false;
        let sdk = env.clientMock._client(botUserId);
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
        let newChannel = "#coffee";

        // Expect the following commands to be sent in order
        let recvCommands = ["JOIN", "TOPIC", "PART", "STUPID"];

        let cmdIx = 0;
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

        for (let i = 0; i < commands.length; i++) {
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
        let newChannel = "#coffee";

        // Expect the following commands to be sent in order
        let recvCommands = ["JOIN", "TOPIC", "PART", "STUPID"];

        let cmdIx = 0;
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

        for (let i = 0; i < commands.length; i++) {
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
        let cmdCount = 0;
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
        let cmdCount = 0;
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

        let sdk = env.clientMock._client(botUserId);
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

        let botLeft = false
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

        let sdk = env.clientMock._client(botUserId);
        sdk.roomState.and.callFake(
            function (roomId) {
                expect(roomId).toBe(adminRoomId, 'Room state returned should be for admin room');
                return Promise.resolve([
                    {content: {membership: "join"}, type: "m.room.member", state_key: ":)"},
                    {content: {membership: "join"}, type: "m.room.member", state_key: ";)"}
                ]);
            }
        );

        let botLeft = false
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

    it("should respond with a feature status for !feature", function(done) {
        const sdk = env.clientMock._client(botUserId);
        sdk.sendEvent.and.callFake((roomId, type, content) => {
            expect(roomId).toEqual(adminRoomId);
            expect(content.msgtype).toEqual("m.notice");
            expect(content.body).toEqual("'mentions' is set to the default value.");
            done();
            return Promise.resolve({});
        });

        env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "!feature mentions",
                msgtype: "m.text"
            },
            user_id: userId,
            room_id: adminRoomId,
            type: "m.room.message"
        });
    });

    it("should set feature status with !feature", function(done) {
        const sdk = env.clientMock._client(botUserId);
        let msgN = 0;
        sdk.sendEvent.and.callFake((roomId, type, content) => {
            if (msgN === 0) {
                expect(roomId).toEqual(adminRoomId);
                expect(content.msgtype).toEqual("m.notice");
                expect(content.body).toEqual("Set mentions to true.");
                msgN++;
                env.mockAppService._trigger("type:m.room.message", {
                    content: {
                        body: "!feature mentions",
                        msgtype: "m.text"
                    },
                    user_id: userId,
                    room_id: adminRoomId,
                    type: "m.room.message"
                });
            }
            else {
                expect(roomId).toEqual(adminRoomId);
                expect(content.msgtype).toEqual("m.notice");
                expect(content.body).toEqual("'mentions' is enabled.");
                done();
            }
            return Promise.resolve({});
        });

        env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "!feature mentions true",
                msgtype: "m.text"
            },
            user_id: userId,
            room_id: adminRoomId,
            type: "m.room.message"
        });
    });

    it("!feature should fail with a missing or invalidate feature-name", function(done) {
        const sdk = env.clientMock._client(botUserId);
        let msgN = 0;
        sdk.sendEvent.and.callFake((roomId, type, content) => {
            expect(roomId).toEqual(adminRoomId);
            expect(content.msgtype).toEqual("m.notice");
            expect(content.body.startsWith(
                "Missing or unknown feature flag. Must be one of:"
            )).toBe(true);
            msgN++
            if (msgN === 3) {
                done();
            }
            return Promise.resolve({});
        });
        for (let body of ["!feature", "!feature doggo", "!feature enabled"]) {
            env.mockAppService._trigger("type:m.room.message", {
                content: {
                    body,
                    msgtype: "m.text"
                },
                user_id: userId,
                room_id: adminRoomId,
                type: "m.room.message"
            });
        }
    });

    it("should set feature status with !feature", function(done) {
        const sdk = env.clientMock._client(botUserId);
        let msgN = 0;
        sdk.sendEvent.and.callFake((roomId, type, content) => {
            if (msgN === 0) {
                expect(roomId).toEqual(adminRoomId);
                expect(content.msgtype).toEqual("m.notice");
                expect(content.body).toEqual("Parameter must be either true, false or default.");
                msgN++;
                env.mockAppService._trigger("type:m.room.message", {
                    content: {
                        body: "!feature mentions",
                        msgtype: "m.text"
                    },
                    user_id: userId,
                    room_id: adminRoomId,
                    type: "m.room.message"
                });
            }
            else {
                expect(roomId).toEqual(adminRoomId);
                expect(content.msgtype).toEqual("m.notice");
                expect(content.body).toEqual("'mentions' is set to the default value.");
                done();
            }
            return Promise.resolve({});
        });

        env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "!feature mentions bacon",
                msgtype: "m.text"
            },
            user_id: userId,
            room_id: adminRoomId,
            type: "m.room.message"
        });
    });

    it("should be able to store a password with !storepass", async function() {
        const sdk = env.clientMock._client(botUserId);

        const sendPromise = sdk.sendEvent.and.callFake(async (roomId, _, content) => {
            expect(roomId).toEqual(adminRoomId);
            expect(content.msgtype).toEqual("m.notice");
            expect(content.body).toEqual(
                "Successfully stored password for irc.example. You will now be reconnected to IRC."
            );
            return {};
        });

        const disconnectPromise = env.ircMock._whenClient(roomMapping.server, userIdNick, "disconnect", () => { });
        const connectPromise = env.ircMock._whenClient(roomMapping.server, userIdNick, "connect", () => { });
        await env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "!storepass foobar",
                msgtype: "m.text"
            },
            user_id: userId,
            room_id: adminRoomId,
            type: "m.room.message"
        });
        await sendPromise;
        // Ensure that the user reconnects
        await disconnectPromise;
        await connectPromise;
    });

    it("should be able to store a username:password with !storepass", async function() {
        const password = "mynick:foopassword"
        const sdk = env.clientMock._client(botUserId);

        const sendPromise = sdk.sendEvent.and.callFake(async (roomId, _, content) => {
            expect(roomId).toEqual(adminRoomId);
            expect(content.msgtype).toEqual("m.notice");
            expect(content.body).toEqual(
                "Successfully stored password for irc.example. You will now be reconnected to IRC."
            );
            return {};
        });
        const disconnectPromise = env.ircMock._whenClient(roomMapping.server, userIdNick, "disconnect", () => { });
        const connectPromise = env.ircMock._whenClient(roomMapping.server, userIdNick, "connect", (client) => {
            const opts = client.opts;
            expect(opts.password).toBe(password);
        });

        await env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: `!storepass ${password}`,
                msgtype: "m.text"
            },
            user_id: userId,
            room_id: adminRoomId,
            type: "m.room.message"
        });
        await sendPromise;
        await disconnectPromise;
        await connectPromise;
    });


    it("should be able to remove a password with !removepass", async function() {
        const sdk = env.clientMock._client(botUserId);

        let sendPromise = sdk.sendEvent.and.callFake(async (roomId, _, content) => {
            expect(roomId).toEqual(adminRoomId);
            expect(content.msgtype).toEqual("m.notice");
            expect(content.body).toEqual(
                "Successfully stored password for irc.example. You will now be reconnected to IRC."
            );
            return {};
        });

        await env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "!storepass foobar",
                msgtype: "m.text"
            },
            user_id: userId,
            room_id: adminRoomId,
            type: "m.room.message"
        });

        sendPromise = sdk.sendEvent.and.callFake(async (roomId, _, content) => {
            expect(roomId).toEqual(adminRoomId);
            expect(content.msgtype).toEqual("m.notice");
            expect(content.body).toEqual("Successfully removed password.");
            return {};
        });

        await env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "!removepass",
                msgtype: "m.text"
            },
            user_id: userId,
            room_id: adminRoomId,
            type: "m.room.message"
        });
        await sendPromise;
    });
});
