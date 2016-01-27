"use strict";
var Promise = require("bluebird");
var test = require("../util/test");

// set up integration testing mocks
var env = test.mkEnv();

// set up test config
var appConfig = env.appConfig;
var ircConfig = appConfig.ircConfig;
var roomMapping = appConfig.roomMapping;

describe("Dynamic channels", function() {
    var testUser = {
        id: "@flibble:wibble",
        nick: "flibble"
    };

    beforeEach(function(done) {
        ircConfig.servers[roomMapping.server].dynamicChannels.enabled = true;
        ircConfig.servers[roomMapping.server].dynamicChannels.visibility = "public";
        test.beforeEach(this, env); // eslint-disable-line no-invalid-this

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

        test.initEnv(env).done(function() {
            done();
        });
    });

    it("should join IRC channels when it receives special alias queries",
    function(done) {
        // Default mapping => #irc_$SERVER_$CHANNEL
        var tChannel = "#foobar";
        var tRoomId = "!newroom:id";
        var tAliasLocalpart = "irc_" + roomMapping.server + "_" + tChannel;
        var tAlias = "#" + tAliasLocalpart + ":" + appConfig.homeServerDomain;

        // when we get the connect/join requests, accept them.
        var joinedIrcChannel = false;
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "join",
        function(client, chan, cb) {
            if (chan === tChannel) {
                joinedIrcChannel = true;
                if (cb) { cb(); }
            }
        });

        // when we get the create room request, process it.
        var sdk = env.clientMock._client();
        sdk.createRoom.andCallFake(function(opts) {
            expect(opts.room_alias_name).toEqual(tAliasLocalpart);
            return Promise.resolve({
                room_id: tRoomId
            });
        });
        sdk.sendStateEvent.andCallFake(function(roomId, eventType, obj) {
            expect(roomId).toEqual(tRoomId);
            expect(eventType).toEqual("m.room.history_visibility");
            expect(obj).toEqual({history_visibility: "joined"});
            return Promise.resolve({});
        });

        env.mockAsapiController._queryAlias(tAlias).done(function() {
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
        ircConfig.servers[roomMapping.server].dynamicChannels.federate = true;

        var tChannel = "#foobar";
        var tRoomId = "!newroom:id";
        var tAliasLocalpart = "irc_" + roomMapping.server + "_" + tChannel;
        var tAlias = "#" + tAliasLocalpart + ":" + appConfig.homeServerDomain;

        // when we get the connect/join requests, accept them.
        var joinedIrcChannel = false;
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "join",
        function(client, chan, cb) {
            if (chan === tChannel) {
                joinedIrcChannel = true;
                if (cb) { cb(); }
            }
        });

        // when we get the create room request, process it.
        var sdk = env.clientMock._client();
        sdk.createRoom.andCallFake(function(opts) {
            expect(opts.creation_content).toEqual({"m.federate": true});
            return Promise.resolve({
                room_id: tRoomId
            });
        });

        sdk.sendStateEvent.andCallFake(function(roomId, eventType, obj) {
            expect(roomId).toEqual(tRoomId);
            expect(eventType).toEqual("m.room.history_visibility");
            expect(obj).toEqual({history_visibility: "joined"});
            return Promise.resolve({});
        });

        env.mockAsapiController._queryAlias(tAlias).done(function() {
            expect(joinedIrcChannel).toBe(true, "Failed to join irc channel");
            done();
        }, function(e) {
            console.error("Failed to join IRC channel: %s", JSON.stringify(e));
        });
    });

    it("should create non federated room when joining channel and federation is disabled",
    function(done) {
        ircConfig.servers[roomMapping.server].dynamicChannels.federate = false;

        var tChannel = "#foobar";
        var tRoomId = "!newroom:id";
        var tAliasLocalpart = "irc_" + roomMapping.server + "_" + tChannel;
        var tAlias = "#" + tAliasLocalpart + ":" + appConfig.homeServerDomain;

        // when we get the connect/join requests, accept them.
        var joinedIrcChannel = false;
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "join",
        function(client, chan, cb) {
            if (chan === tChannel) {
                joinedIrcChannel = true;
                if (cb) { cb(); }
            }
        });

        // when we get the create room request, process it.
        var sdk = env.clientMock._client();
        sdk.createRoom.andCallFake(function(opts) {
            expect(opts.creation_content).toEqual({"m.federate": false});
            return Promise.resolve({
                room_id: tRoomId
            });
        });

        sdk.sendStateEvent.andCallFake(function(roomId, eventType, obj) {
            expect(roomId).toEqual(tRoomId);
            expect(eventType).toEqual("m.room.history_visibility");
            expect(obj).toEqual({history_visibility: "joined"});
            return Promise.resolve({});
        });

        env.mockAsapiController._queryAlias(tAlias).done(function() {
            expect(joinedIrcChannel).toBe(true, "Failed to join irc channel");
            done();
        }, function(e) {
            console.error("Failed to join IRC channel: %s", JSON.stringify(e));
        });
    });

    it("should point to the same room ID for aliases with different cases",
    function(done) {
        // Default mapping => #irc_$SERVER_$CHANNEL
        var tChannel = "#foobar";
        var tRoomId = "!newroom:id";
        var tAliasLocalpart = "irc_" + roomMapping.server + "_" + tChannel;
        var tAlias = "#" + tAliasLocalpart + ":" + appConfig.homeServerDomain;
        var tAliasCapsLocalpart = "irc_" + roomMapping.server + "_#FooBar";
        var tCapsAlias = "#" + tAliasCapsLocalpart + ":" + appConfig.homeServerDomain;

        // when we get the connect/join requests, accept them.
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "join",
        function(client, chan, cb) {
            expect(chan).toEqual(tChannel);
            if (cb) { cb(); }
        });

        // when we get the create room request, process it.
        var sdk = env.clientMock._client();
        sdk.createRoom.andCallFake(function(opts) {
            expect(opts.room_alias_name).toEqual(tAliasLocalpart);
            return Promise.resolve({
                room_id: tRoomId
            });
        });

        sdk.sendStateEvent.andCallFake(function(roomId, eventType, obj) {
            expect(roomId).toEqual(tRoomId);
            expect(eventType).toEqual("m.room.history_visibility");
            expect(obj).toEqual({history_visibility: "joined"});
            return Promise.resolve({});
        });

        var madeAlias = false;
        sdk.createAlias.andCallFake(function(alias, roomId) {
            madeAlias = true;
            expect(roomId).toEqual(tRoomId);
            expect(alias).toEqual(tCapsAlias);
            return Promise.resolve({});
        });

        env.mockAsapiController._queryAlias(tAlias).then(function() {
            return env.mockAsapiController._queryAlias(tCapsAlias);
        }).done(function() {
            expect(madeAlias).toBe(true, "Failed to create alias");
            done();
        });
    });
});

describe("Dynamic channels (disabled)", function() {
    var testUser = {
        id: "@flibble:wibble",
        nick: "flibble"
    };

    beforeEach(function(done) {
        ircConfig.servers[roomMapping.server].dynamicChannels.enabled = false;
        test.beforeEach(this, env); // eslint-disable-line no-invalid-this

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
        env.dbHelper._reset(appConfig.databaseUri).then(function() {
            env.ircService.configure(appConfig.ircConfig);
            return env.ircService.register(
                env.mockAsapiController, appConfig.serviceConfig
            );
        }).done(function() {
            done();
        });
    });

    it("should NOT join IRC channels when it receives special alias queries",
    function(done) {
        var tChannel = "#foobar";
        var tRoomId = "!newroom:id";
        var tAliasLocalpart = roomMapping.server + "_" + tChannel;
        var tAlias = "#" + tAliasLocalpart + ":" + appConfig.homeServerDomain;

        // when we get the connect/join requests, accept them.
        var joinedIrcChannel = false;
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "join",
        function(client, chan, cb) {
            if (chan === tChannel) {
                joinedIrcChannel = true;
            }
            if (cb) { cb(); }
        });

        // when we get the create room request, process it.
        var sdk = env.clientMock._client();
        sdk.createRoom.andCallFake(function(opts) {
            return Promise.resolve({
                room_id: tRoomId
            });
        });

        sdk.sendStateEvent.andCallFake(function(roomId, eventType, obj) {
            expect(roomId).toEqual(tRoomId);
            expect(eventType).toEqual("m.room.history_visibility");
            expect(obj).toEqual({history_visibility: "joined"});
            return Promise.resolve({});
        });

        env.mockAsapiController._queryAlias(tAlias).catch(function() {
            expect(joinedIrcChannel).toBe(false, "Joined channel by alias");
            done();
        });
    });
});
