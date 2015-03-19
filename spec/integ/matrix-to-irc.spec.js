/*
 * Contains integration tests for all Matrix-initiated events.
 */
"use strict";
// set up integration testing mocks
var proxyquire =  require('proxyquire');
var clientMock = require("../util/client-sdk-mock");
clientMock["@global"] = true; 
var ircMock = require("../util/irc-mock");
ircMock["@global"] = true;
var dbHelper = require("../util/db-helper");
var asapiMock = require("../util/asapi-controller-mock");


// s prefix for static test data, t prefix for test instance data
var sDatabaseUri = "mongodb://localhost:27017/matrix-appservice-irc-integration";
var sIrcServer = "irc.example";
var sNick = "a_nick";
var sChannel = "#coffee";
var sRoomId = "!foo:bar";
var sRoomMapping = {};
sRoomMapping[sChannel] = [sRoomId];
var sHomeServerUrl = "https://some.home.server.goeshere";
var sHomeServerDomain = "some.home.server";
var sAppServiceToken = "it's a secret";
var sAppServiceUrl = "https://mywuvelyappservicerunninganircbridgeyay.gome";
var sPort = 2;


// set up config
var ircConfig = {
    databaseUri: sDatabaseUri,
    servers: {}
};
ircConfig.servers[sIrcServer] = {
    nick: sNick,
    expose: {
        channels: true,
        privateMessages: true
    },
    rooms: {
        mappings: sRoomMapping
    }
}
var serviceConfig = {
    hs: sHomeServerUrl,
    hsDomain: sHomeServerDomain,
    token: sAppServiceToken,
    as: sAppServiceUrl,
    port: sPort
};


describe("Matrix-to-IRC", function() {
    var ircService = null;
    var mockAsapiController = null;

    beforeEach(function(done) {
        console.log(" === Matrix-to-IRC Test Start === ");
        ircMock._reset();
        clientMock._reset();
        dbHelper._reset();
        ircService = proxyquire("../../lib/irc-appservice.js", {
            "matirx-js-sdk": clientMock,
            "irc": ircMock
        });
        mockAsapiController = asapiMock.create();

        // do the init
        ircService.configure(ircConfig);
        ircService.register(mockAsapiController, serviceConfig).done(function() {
            done();
        });
    });

    it("should bridge matrix messages as IRC text", function(done) {
        var tUserId = "@flibble:wibble";
        var tIrcNick = "flibble";
        var tBody = "I am a fish";
        mockAsapiController._trigger("type:m.room.message", {
            content: {
                body: tBody,
                msgtype: "m.text"
            },
            user_id: tUserId,
            room_id: sRoomId,
            type: "m.room.message"
        });
        ircMock._findClientAsync(sIrcServer, tIrcNick).then(function(client) {
            return client._triggerConnect();
        }).then(function(client) {
            return client._triggerJoinFor(sChannel);
        }).done(function(client) {
            // check it sent the message
            expect(client.say).toHaveBeenCalled();
            expect(client.say.calls[0].args[0]).toEqual(sChannel);
            expect(client.say.calls[0].args[1]).toEqual(tBody);
            done();
        });
    });

    it("should bridge matrix emotes as IRC actions", function(done) {
        var tUserId = "@flibble:wibble";
        var tIrcNick = "flibble";
        var tBody = "thinks";
        mockAsapiController._trigger("type:m.room.message", {
            content: {
                body: tBody,
                msgtype: "m.emote"
            },
            user_id: tUserId,
            room_id: sRoomId,
            type: "m.room.message"
        });
        ircMock._findClientAsync(sIrcServer, tIrcNick).then(function(client) {
            return client._triggerConnect();
        }).then(function(client) {
            return client._triggerJoinFor(sChannel);
        }).done(function(client) {
            // check it sent the message
            expect(client.action).toHaveBeenCalled();
            expect(client.action.calls[0].args[0]).toEqual(sChannel);
            expect(client.action.calls[0].args[1]).toEqual(tBody);
            done();
        });
    });

    it("should bridge matrix notices as IRC notices", function(done) {
        var tUserId = "@flibble:wibble";
        var tIrcNick = "flibble";
        var tBody = "Some automated message";
        mockAsapiController._trigger("type:m.room.message", {
            content: {
                body: tBody,
                msgtype: "m.notice"
            },
            user_id: tUserId,
            room_id: sRoomId,
            type: "m.room.message"
        });
        ircMock._findClientAsync(sIrcServer, tIrcNick).then(function(client) {
            return client._triggerConnect();
        }).then(function(client) {
            return client._triggerJoinFor(sChannel);
        }).done(function(client) {
            // check it sent the message
            expect(client.ctcp).toHaveBeenCalled();
            expect(client.ctcp.calls[0].args[0]).toEqual(sChannel);
            expect(client.ctcp.calls[0].args[1]).toEqual("notice");
            expect(client.ctcp.calls[0].args[2]).toEqual(tBody);
            done();
        });
    });

    it("should join 1:1 rooms invited from matrix", function(done) {
        done();
    });

    it("should join group chat rooms invited from matrix then leave them", 
    function(done) {
        done();
    });

    it("should join IRC channels when it receives special alias queries", 
    function(done) {
        done();
    });
});