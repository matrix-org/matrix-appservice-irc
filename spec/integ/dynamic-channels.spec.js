const Promise = require("bluebird");
const envBundle = require("../util/env-bundle");

describe("Dynamic channels", function() {
    let testUser = {
        id: "@flibble:wibble",
        nick: "flibble"
    };

    const {env, config, roomMapping, test} = envBundle();

    beforeEach(test.coroutine(function*() {
        config.ircService.servers[roomMapping.server].dynamicChannels.enabled = true;
        yield test.beforeEach(env);

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

        yield test.initEnv(env, config);
    }));

    afterEach(test.coroutine(function*() {
        yield test.afterEach(env);
    }));

    it("should join IRC channels when it receives special alias queries",
    function(done) {
        // Default mapping => #irc_$SERVER_$CHANNEL
        let tChannel = "#foobar";
        let tRoomId = "!newroom:id";
        let tAliasLocalpart = "irc_" + roomMapping.server + "_" + tChannel;
        let tAlias = "#" + tAliasLocalpart + ":" + config.homeserver.domain;

        // when we get the connect/join requests, accept them.
        let joinedIrcChannel = false;
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "join",
        function(client, chan, cb) {
            if (chan === tChannel) {
                joinedIrcChannel = true;
                if (cb) { cb(); }
            }
        });

        // when we get the create room request, process it.
        let sdk = env.clientMock._client(config._botUserId);
        sdk.createRoom.and.callFake(function(opts) {
            expect(opts.room_alias_name).toEqual(tAliasLocalpart);
            return Promise.resolve({
                room_id: tRoomId
            });
        });
        sdk.sendStateEvent.and.callFake(function(roomId, eventType, obj) {
            expect(roomId).toEqual(tRoomId);
            expect(eventType).toEqual("m.room.history_visibility");
            expect(obj).toEqual({history_visibility: "joined"});
            return Promise.resolve({});
        });

        env.mockAppService._queryAlias(tAlias).done(function() {
            if (joinedIrcChannel) {
                done();
            }
            else {
                expect(false).toBe(true, "Failed to join irc channel");
            }
        }, function(e) {
            console.error("Failed to join IRC channel: %s", JSON.stringify(e));
        });
    });

    it("should create federated room when joining channel and federation is enabled",
    function(done) {
        config.ircService.servers[roomMapping.server].dynamicChannels.federate = true;

        let tChannel = "#foobar";
        let tRoomId = "!newroom:id";
        let tAliasLocalpart = "irc_" + roomMapping.server + "_" + tChannel;
        let tAlias = "#" + tAliasLocalpart + ":" + config.homeserver.domain;

        // when we get the connect/join requests, accept them.
        let joinedIrcChannel = false;
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "join",
        function(client, chan, cb) {
            if (chan === tChannel) {
                joinedIrcChannel = true;
                if (cb) { cb(); }
            }
        });

        // when we get the create room request, process it.
        let sdk = env.clientMock._client(config._botUserId);
        sdk.createRoom.and.callFake(function(opts) {
            expect(opts.roomVersion).toBeUndefined();
            expect(opts.creation_content).toEqual({"m.federate": true});
            return Promise.resolve({
                room_id: tRoomId
            });
        });

        sdk.sendStateEvent.and.callFake(function(roomId, eventType, obj) {
            expect(roomId).toEqual(tRoomId);
            expect(eventType).toEqual("m.room.history_visibility");
            expect(obj).toEqual({history_visibility: "joined"});
            return Promise.resolve({});
        });

        env.mockAppService._queryAlias(tAlias).done(function() {
            expect(joinedIrcChannel).toBe(true, "Failed to join irc channel");
            done();
        }, function(e) {
            console.error("Failed to join IRC channel: %s", JSON.stringify(e));
        });
    });

    it("should point to the same room ID for aliases with different cases",
    function(done) {
        // Default mapping => #irc_$SERVER_$CHANNEL
        let tChannel = "#foobar";
        let tRoomId = "!newroom:id";
        let tAliasLocalpart = "irc_" + roomMapping.server + "_" + tChannel;
        let tAlias = "#" + tAliasLocalpart + ":" + config.homeserver.domain;
        let tAliasCapsLocalpart = "irc_" + roomMapping.server + "_#FooBar";
        let tCapsAlias = "#" + tAliasCapsLocalpart + ":" + config.homeserver.domain;

        // when we get the connect/join requests, accept them.
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "join",
        function(client, chan, cb) {
            expect(chan).toEqual(tChannel);
            if (cb) { cb(); }
        });

        // when we get the create room request, process it.
        let sdk = env.clientMock._client(config._botUserId);
        sdk.createRoom.and.callFake(function(opts) {
            expect(opts.room_alias_name).toEqual(tAliasLocalpart);
            return Promise.resolve({
                room_id: tRoomId
            });
        });

        sdk.sendStateEvent.and.callFake(function(roomId, eventType, obj) {
            expect(roomId).toEqual(tRoomId);
            expect(eventType).toEqual("m.room.history_visibility");
            expect(obj).toEqual({history_visibility: "joined"});
            return Promise.resolve({});
        });

        let madeAlias = false;
        sdk.createAlias.and.callFake(function(alias, roomId) {
            madeAlias = true;
            expect(roomId).toEqual(tRoomId);
            expect(alias).toEqual(tCapsAlias);
            return Promise.resolve({});
        });

        env.mockAppService._queryAlias(tAlias).then(function() {
            return env.mockAppService._queryAlias(tCapsAlias);
        }).done(function() {
            expect(madeAlias).toBe(true, "Failed to create alias");
            done();
        });
    });

    it("should create a channel with the specified room version", (done) => {
        env.ircBridge.getServer(roomMapping.server)
            .config.dynamicChannels.roomVersion = "the-best-version";

        const tChannel = "#foobar";
        const tRoomId = "!newroom:id";
        const tAliasLocalpart = "irc_" + roomMapping.server + "_" + tChannel;
        const tAlias = "#" + tAliasLocalpart + ":" + config.homeserver.domain;

        // when we get the connect/join requests, accept them.
        let joinedIrcChannel = false;
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "join",
        function(client, chan, cb) {
            if (chan === tChannel) {
                joinedIrcChannel = true;
                if (cb) { cb(); }
            }
        });

        // when we get the create room request, process it.
        let sdk = env.clientMock._client(config._botUserId);
        sdk.createRoom.and.callFake(function(opts) {
            console.log(opts);
            expect(opts.room_version).toEqual("the-best-version");
            return Promise.resolve({
                room_id: tRoomId
            });
        });

        sdk.sendStateEvent.and.callFake(function(roomId, eventType, obj) {
            expect(roomId).toEqual(tRoomId);
            expect(eventType).toEqual("m.room.history_visibility");
            expect(obj).toEqual({history_visibility: "joined"});
            return Promise.resolve({});
        });

        env.mockAppService._queryAlias(tAlias).done(function() {
            expect(joinedIrcChannel).toBe(true, "Failed to join irc channel");
            done();
        }, function(e) {
            console.error("Failed to join IRC channel: %s", JSON.stringify(e));
        });

    });
});

describe("Dynamic channels (federation disabled)", function() {
    let testUser = {
        id: "@flibble:wibble",
        nick: "flibble"
    };

    const {env, config, roomMapping, test} = envBundle();

    beforeEach(test.coroutine(function*() {
        yield test.beforeEach(env);

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
        yield test.initEnv(env, config);
    }));

    afterEach(test.coroutine(function*() {
        yield test.afterEach(env);
    }));

    it("should create non federated room when joining channel and federation is disabled",
    function(done) {
        let tChannel = "#foobar";
        let tRoomId = "!newroom:id";
        let tAliasLocalpart = "irc_" + roomMapping.server + "_" + tChannel;
        let tAlias = "#" + tAliasLocalpart + ":" + config.homeserver.domain;

        // when we get the connect/join requests, accept them.
        let joinedIrcChannel = false;
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "join",
        function(client, chan, cb) {
            if (chan === tChannel) {
                joinedIrcChannel = true;
                if (cb) { cb(); }
            }
        });

        // when we get the create room request, process it.
        let sdk = env.clientMock._client(config._botUserId);
        sdk.createRoom.and.callFake(function(opts) {
            expect(opts.creation_content).toEqual({"m.federate": false});
            return Promise.resolve({
                room_id: tRoomId
            });
        });

        sdk.sendStateEvent.and.callFake(function(roomId, eventType, obj) {
            expect(roomId).toEqual(tRoomId);
            expect(eventType).toEqual("m.room.history_visibility");
            expect(obj).toEqual({history_visibility: "joined"});
            return Promise.resolve({});
        });

        env.mockAppService._queryAlias(tAlias).done(function() {
            expect(joinedIrcChannel).toBe(true, "Failed to join irc channel");
            done();
        }, function(e) {
            console.error("Failed to join IRC channel: %s", JSON.stringify(e));
        });
    });
});

describe("Dynamic channels (disabled)", function() {
    let testUser = {
        id: "@flibble:wibble",
        nick: "flibble"
    };

    const {env, config, roomMapping, test} = envBundle();

    beforeEach(test.coroutine(function*() {
        config.ircService.servers[roomMapping.server].dynamicChannels.enabled = false;
        yield test.beforeEach(env);

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

        // do the init
        yield test.initEnv(env, config);
    }));

    afterEach(test.coroutine(function*() {
        yield test.afterEach(env);
    }));

    it("should NOT join IRC channels when it receives special alias queries",
    function(done) {
        let tChannel = "#foobar";
        let tRoomId = "!newroom:id";
        let tAliasLocalpart = roomMapping.server + "_" + tChannel;
        let tAlias = "#" + tAliasLocalpart + ":" + config.homeserver.domain;

        // when we get the connect/join requests, accept them.
        let joinedIrcChannel = false;
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "join",
        function(client, chan, cb) {
            if (chan === tChannel) {
                joinedIrcChannel = true;
            }
            if (cb) { cb(); }
        });

        // when we get the create room request, process it.
        let sdk = env.clientMock._client(config._botUserId);
        sdk.createRoom.and.callFake(function(opts) {
            return Promise.resolve({
                room_id: tRoomId
            });
        });

        sdk.sendStateEvent.and.callFake(function(roomId, eventType, obj) {
            expect(roomId).toEqual(tRoomId);
            expect(eventType).toEqual("m.room.history_visibility");
            expect(obj).toEqual({history_visibility: "joined"});
            return Promise.resolve({});
        });

        env.mockAppService._queryAlias(tAlias).done(function() {
            expect(joinedIrcChannel).toBe(false, "Joined channel by alias");
            done();
        });
    });
});
