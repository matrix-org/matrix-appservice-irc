const envBundle = require("../util/env-bundle");

describe("Dynamic channels", () => {
    const testUser = {
        id: "@flibble:wibble",
        nick: "flibble"
    };

    const {env, config, roomMapping, test} = envBundle();

    beforeEach(async () => {
        config.ircService.servers[roomMapping.server].dynamicChannels.enabled = true;
        await test.beforeEach(env);

        // accept connection requests
        env.ircMock._autoConnectNetworks(
            roomMapping.server, testUser.nick, roomMapping.server
        );
        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );
        env.ircMock._autoJoinChannels(
            roomMapping.server, testUser.nick, roomMapping.channel
        );

        await test.initEnv(env, config);
    });

    afterEach(async () => test.afterEach(env));

    it("should join IRC channels when it receives special alias queries", async () => {
        // Default mapping => #irc_$SERVER_$CHANNEL
        const tChannel = "#foobar";
        const tRoomId = "!newroom:id";
        const tAliasLocalpart = "irc_" + roomMapping.server + "_" + tChannel;
        const tAlias = "#" + tAliasLocalpart + ":" + config.homeserver.domain;

        // when we get the connect/join requests, accept them.
        let joinedIrcChannel = false;
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "join", (client, chan, cb) => {
            if (chan === tChannel) {
                joinedIrcChannel = true;
                if (cb) { cb(); }
            }
        });

        // when we get the create room request, process it.
        const sdk = env.clientMock._client(config._botUserId);
        sdk.createRoom.and.callFake(function(opts) {
            expect(opts.room_alias_name).toEqual(tAliasLocalpart);
            return Promise.resolve({
                room_id: tRoomId
            });
        });
        sdk.sendStateEvent.and.callFake(function(roomId, eventType, _key, obj) {
            expect(roomId).toEqual(tRoomId);
            expect(eventType).toEqual("m.room.history_visibility");
            expect(obj).toEqual({history_visibility: "joined"});
            return Promise.resolve({});
        });

        await env.mockAppService._queryAlias(tAlias);
        expect(joinedIrcChannel).withContext("Failed to join irc channel").toBeTrue();
    });

    it("should create federated room when joining channel and federation is enabled", async () => {
        config.ircService.servers[roomMapping.server].dynamicChannels.federate = true;

        const tChannel = "#foobar";
        const tRoomId = "!newroom:id";
        const tAliasLocalpart = "irc_" + roomMapping.server + "_" + tChannel;
        const tAlias = "#" + tAliasLocalpart + ":" + config.homeserver.domain;

        // when we get the connect/join requests, accept them.
        let joinedIrcChannel = false;
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "join", (client, chan, cb) => {
            if (chan === tChannel) {
                joinedIrcChannel = true;
                if (cb) { cb(); }
            }
        });

        // when we get the create room request, process it.
        const sdk = env.clientMock._client(config._botUserId);
        sdk.createRoom.and.callFake(({roomVersion, creation_content}) => {
            expect(roomVersion).toBeUndefined();
            expect(creation_content).toEqual({"m.federate": true});
            return {
                room_id: tRoomId
            };
        });

        sdk.sendStateEvent.and.callFake((roomId, eventType, _key, obj) => {
            expect(roomId).toEqual(tRoomId);
            expect(eventType).toEqual("m.room.history_visibility");
            expect(obj).toEqual({history_visibility: "joined"});
            return {};
        });

        await env.mockAppService._queryAlias(tAlias);
        expect(joinedIrcChannel).withContext("Failed to join irc channel").toBeTrue();
    });

    it("should point to the same room ID for aliases with different cases", async () => {
        // Default mapping => #irc_$SERVER_$CHANNEL
        const tChannel = "#foobar";
        const tRoomId = "!newroom:id";
        const tAliasLocalpart = "irc_" + roomMapping.server + "_" + tChannel;
        const tAlias = "#" + tAliasLocalpart + ":" + config.homeserver.domain;
        const tAliasCapsLocalpart = "irc_" + roomMapping.server + "_#FooBar";
        const tCapsAlias = "#" + tAliasCapsLocalpart + ":" + config.homeserver.domain;

        // when we get the connect/join requests, accept them.
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "join", (client, chan, cb) => {
            expect(chan).toEqual(tChannel);
            if (cb) { cb(); }
        });

        // when we get the create room request, process it.
        const sdk = env.clientMock._client(config._botUserId);
        sdk.createRoom.and.callFake(({ room_alias_name }) => {
            expect(room_alias_name).toEqual(tAliasLocalpart);
            return tRoomId;
        });

        sdk.sendStateEvent.and.callFake(function(roomId, eventType, _key, obj) {
            expect(roomId).toEqual(tRoomId);
            expect(eventType).toEqual("m.room.history_visibility");
            expect(obj).toEqual({history_visibility: "joined"});
            return {};
        });

        let madeAlias = false;
        sdk.createRoomAlias.and.callFake((alias, roomId) => {
            madeAlias = true;
            expect(roomId).toEqual(tRoomId);
            expect(alias).toEqual(tCapsAlias);
            return {};
        });

        await env.mockAppService._queryAlias(tAlias);
        await env.mockAppService._queryAlias(tCapsAlias);
        expect(madeAlias).withContext("Failed to create alias").toBeTrue();
    });

    it("should create a channel with the specified room version", async () => {
        env.ircBridge.getServer(roomMapping.server)
            .config.dynamicChannels.roomVersion = "the-best-version";

        const tChannel = "#foobar";
        const tRoomId = "!newroom:id";
        const tAliasLocalpart = "irc_" + roomMapping.server + "_" + tChannel;
        const tAlias = "#" + tAliasLocalpart + ":" + config.homeserver.domain;

        // when we get the connect/join requests, accept them.
        let joinedIrcChannel = false;
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "join", (_client, chan, cb) => {
            if (chan === tChannel) {
                joinedIrcChannel = true;
                if (cb) { cb(); }
            }
        });

        // when we get the create room request, process it.
        const sdk = env.clientMock._client(config._botUserId);
        sdk.createRoom.and.callFake(function(opts) {
            expect(opts.room_version).toEqual("the-best-version");
            return Promise.resolve({
                room_id: tRoomId
            });
        });

        sdk.sendStateEvent.and.callFake(function(roomId, eventType, _key, obj) {
            expect(roomId).toEqual(tRoomId);
            expect(eventType).toEqual("m.room.history_visibility");
            expect(obj).toEqual({history_visibility: "joined"});
            return Promise.resolve({});
        });

        await env.mockAppService._queryAlias(tAlias)
        expect(joinedIrcChannel).withContext("Failed to join irc channel").toBeTrue(true);
    });
});

describe("Dynamic channels (federation disabled)", function() {
    const testUser = {
        id: "@flibble:wibble",
        nick: "flibble"
    };

    const {env, config, roomMapping, test} = envBundle();

    beforeEach(async () => {
        await test.beforeEach(env);

        config.ircService.servers[
            roomMapping.server].dynamicChannels.enabled = true;
        config.ircService.servers[
            roomMapping.server].dynamicChannels.federate = false;

        // accept connection requests
        env.ircMock._autoConnectNetworks(
            roomMapping.server, testUser.nick, roomMapping.server
        );
        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );
        env.ircMock._autoJoinChannels(
            roomMapping.server, testUser.nick, roomMapping.channel
        );
        await test.initEnv(env, config);
    });

    afterEach(async () => test.afterEach(env));

    it("should create non federated room when joining channel and federation is disabled", (done) => {
        const tChannel = "#foobar";
        const tRoomId = "!newroom:id";
        const tAliasLocalpart = "irc_" + roomMapping.server + "_" + tChannel;
        const tAlias = "#" + tAliasLocalpart + ":" + config.homeserver.domain;

        // when we get the connect/join requests, accept them.
        let joinedIrcChannel = false;
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "join", (client, chan, cb) => {
            if (chan === tChannel) {
                joinedIrcChannel = true;
                if (cb) { cb(); }
            }
        });

        // when we get the create room request, process it.
        const sdk = env.clientMock._client(config._botUserId);
        sdk.createRoom.and.callFake(function(opts) {
            expect(opts.creation_content).toEqual({"m.federate": false});
            return Promise.resolve({
                room_id: tRoomId
            });
        });

        sdk.sendStateEvent.and.callFake(function(roomId, eventType, _key, obj) {
            expect(roomId).toEqual(tRoomId);
            expect(eventType).toEqual("m.room.history_visibility");
            expect(obj).toEqual({history_visibility: "joined"});
            return Promise.resolve({});
        });

        env.mockAppService._queryAlias(tAlias).then(function() {
            expect(joinedIrcChannel).toBe(true, "Failed to join irc channel");
            done();
        }, function(e) {
            console.error("Failed to join IRC channel: %s", JSON.stringify(e));
        });
    });
});

describe("Dynamic channels (disabled)", function() {
    const testUser = {
        id: "@flibble:wibble",
        nick: "flibble"
    };

    const {env, config, roomMapping, test} = envBundle();

    beforeEach(async () => {
        config.ircService.servers[roomMapping.server].dynamicChannels.enabled = false;
        await test.beforeEach(env);

        // accept connection requests
        env.ircMock._autoConnectNetworks(
            roomMapping.server, testUser.nick, roomMapping.server
        );
        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );
        env.ircMock._autoJoinChannels(
            roomMapping.server, testUser.nick, roomMapping.channel
        );

        await test.initEnv(env, config);
    });

    afterEach(async () => test.afterEach(env));

    it("should NOT join IRC channels when it receives special alias queries", (done) => {
        const tChannel = "#foobar";
        const tRoomId = "!newroom:id";
        const tAliasLocalpart = roomMapping.server + "_" + tChannel;
        const tAlias = "#" + tAliasLocalpart + ":" + config.homeserver.domain;

        // when we get the connect/join requests, accept them.
        let joinedIrcChannel = false;
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "join", (client, chan, cb) => {
            if (chan === tChannel) {
                joinedIrcChannel = true;
            }
            if (cb) { cb(); }
        });

        // when we get the create room request, process it.
        const sdk = env.clientMock._client(config._botUserId);
        sdk.createRoom.and.callFake(function(opts) {
            return Promise.resolve({
                room_id: tRoomId
            });
        });

        sdk.sendStateEvent.and.callFake(function(roomId, eventType, _key, obj) {
            expect(roomId).toEqual(tRoomId);
            expect(eventType).toEqual("m.room.history_visibility");
            expect(obj).toEqual({history_visibility: "joined"});
            return Promise.resolve({});
        });

        env.mockAppService._queryAlias(tAlias).then(function() {
            expect(joinedIrcChannel).toBe(false, "Joined channel by alias");
            done();
        });
    });
});
