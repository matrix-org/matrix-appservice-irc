const envBundle = require("../util/env-bundle");

describe("Static channels", function() {
    const staticTestChannel = "#astaticchannel";
    const generatedTestChannel = "#ageneratedchannel";
    const generatedRoomId = "!gen:bar";
    const {env, config, roomMapping, botUserId, test} = envBundle();

    beforeEach(async function() {
        config.ircService.servers[roomMapping.server].mappings[staticTestChannel] = {
            roomIds: ["!foo:bar"],
        };

        config.ircService.servers[roomMapping.server].mappings[generatedTestChannel] = {
            createRoom: true,
        };

        await test.beforeEach(env);

        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );

        // Ensure rooms are created on startup
        sdk = env.clientMock._client(botUserId);
        sdk.createRoom.and.callFake(async function(opts) {
            return {
                room_id: generatedRoomId
            };
        });

        await test.initEnv(env, config);
    });

    afterEach(async function() {
        await test.afterEach(env);
    });

    it("should insert static channel mappings to bridge store", async function () {
        const store = await env.ircBridge.getStore();
        const server = await env.ircBridge.getServer(roomMapping.server);
        const mappings = await store.getMappingsForChannelByOrigin(server, staticTestChannel, "config");
        expect(mappings.length).toEqual(1);
        const entry = mappings[0];
        expect(entry.matrix.roomId).toEqual("!foo:bar");
        expect(entry.remote.data).toEqual({
            domain: roomMapping.server,
            channel: staticTestChannel,
            type: "channel",
        });
        expect(entry.data.origin).toEqual("config");
    });

    it("should clear static channel mappings from bridge store", async function () {
        const store = await env.ircBridge.getStore();
        const server = await env.ircBridge.getServer(roomMapping.server);
        await store.removeConfigMappings(server);
        const mappings = await store.getMappingsForChannelByOrigin(server, staticTestChannel, "config");
        expect(mappings.length).toEqual(0);
    });

    it("should create a channel mapping for mappings with createRoom", async function () {
        const store = await env.ircBridge.getStore();
        const server = await env.ircBridge.getServer(roomMapping.server);
        const mappings = await store.getMappingsForChannelByOrigin(server, generatedTestChannel, "config");
        expect(mappings.length).toEqual(1);
        const entry = mappings[0];
        expect(entry.remote.data).toEqual({
            domain: roomMapping.server,
            channel: generatedTestChannel,
            type: "channel",
        });
        expect(entry.matrix.roomId).toEqual(generatedRoomId);
        expect(entry.data.origin).toEqual("config");
    });

    it("should NOT clear channel mappings for mappings with createRoom", async function () {
        const store = await env.ircBridge.getStore();
        const server = await env.ircBridge.getServer(roomMapping.server);
        await store.removeConfigMappings(server);
        const mappings = await store.getMappingsForChannelByOrigin(server, generatedTestChannel, "config");
        expect(mappings.length).toEqual(1);
    });
});