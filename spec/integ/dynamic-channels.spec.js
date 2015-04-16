"use strict";
var q = require("q");

// set up integration testing mocks
var proxyquire =  require('proxyquire');
var clientMock = require("../util/client-sdk-mock");
clientMock["@global"] = true; 
var ircMock = require("../util/irc-client-mock");
ircMock["@global"] = true;
var dbHelper = require("../util/db-helper");
var asapiMock = require("../util/asapi-controller-mock");

// set up test config
var appConfig = require("../util/config-mock");
var roomMapping = appConfig.roomMapping;

describe("Dynamic channels", function() {
    var ircService = null;
    var mockAsapiController = null;

    var testUser = {
        id: "@flibble:wibble",
        nick: "flibble"
    };

    beforeEach(function(done) {
        console.log(" === Dynamic channels Test Start === ");
        appConfig.ircConfig.servers[roomMapping.server].dynamicChannels.enabled = true;
        appConfig.ircConfig.servers[roomMapping.server].dynamicChannels.visibility = "public";
        ircMock._reset();
        clientMock._reset();
        ircService = proxyquire("../../lib/irc-appservice.js", {
            "matrix-js-sdk": clientMock,
            "irc": ircMock
        });
        mockAsapiController = asapiMock.create();

        // accept connection requests
        ircMock._autoConnectNetworks(
            roomMapping.server, testUser.nick, roomMapping.server
        );
        ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );
        ircMock._autoJoinChannels(
            roomMapping.server, testUser.nick, roomMapping.channel
        );

        // do the init
        dbHelper._reset(appConfig.databaseUri).then(function() {
            ircService.configure(appConfig.ircConfig);
            return ircService.register(
                mockAsapiController, appConfig.serviceConfig
            );
        }).done(function() {
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
        ircMock._whenClient(roomMapping.server, roomMapping.botNick, "join",
        function(client, chan, cb) {
            expect(chan).toEqual(tChannel);
            joinedIrcChannel = true;
            if (cb) { cb(); }
        });

        // when we get the create room request, process it.
        var sdk = clientMock._client();
        sdk.createRoom.andCallFake(function(opts) {
            expect(opts.room_alias_name).toEqual(tAliasLocalpart);
            return q({
                room_id: tRoomId
            });
        });
        mockAsapiController._query_alias(tAlias).done(function() {
            if (joinedIrcChannel) {
                done();
            }
        }, function(e) {
            console.error("Failed to join IRC channel: %s", JSON.stringify(e));
        });
    });
});

describe("Dynamic channels (disabled)", function() {
    var ircService = null;
    var mockAsapiController = null;

    var testUser = {
        id: "@flibble:wibble",
        nick: "flibble"
    };

    beforeEach(function(done) {
        appConfig.ircConfig.servers[roomMapping.server].dynamicChannels.enabled = false;
        console.log(" === Dynamic channels disabled Test Start === ");
        ircMock._reset();
        clientMock._reset();
        ircService = proxyquire("../../lib/irc-appservice.js", {
            "matrix-js-sdk": clientMock,
            "irc": ircMock
        });
        mockAsapiController = asapiMock.create();

        // accept connection requests
        ircMock._autoConnectNetworks(
            roomMapping.server, testUser.nick, roomMapping.server
        );
        ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );
        ircMock._autoJoinChannels(
            roomMapping.server, testUser.nick, roomMapping.channel
        );

        // do the init
        dbHelper._reset(appConfig.databaseUri).then(function() {
            ircService.configure(appConfig.ircConfig);
            return ircService.register(
                mockAsapiController, appConfig.serviceConfig
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
        ircMock._whenClient(roomMapping.server, roomMapping.botNick, "join",
        function(client, chan, cb) {
            if (chan === tChannel) {
                joinedIrcChannel = true;
            }
            if (cb) { cb(); }
        });

        // when we get the create room request, process it.
        var sdk = clientMock._client();
        sdk.createRoom.andCallFake(function(opts) {
            return q({
                room_id: tRoomId
            });
        });

        mockAsapiController._query_alias(tAlias).catch(function() {
            expect(joinedIrcChannel).toBe(false, "Joined channel by alias");
            done();
        });
    });
});