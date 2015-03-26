/*
 * Contains integration tests for all IRC-initiated events.
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
var q = require("q");

// s prefix for static test data, t prefix for test instance data
var sDatabaseUri = "mongodb://localhost:27017/matrix-appservice-irc-integration";
var sIrcServer = "irc.example";
var sBotNick = "a_nick";
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
    nick: sBotNick,
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



describe("IRC-to-Matrix message bridging", function() {
    var ircService = null;
    var mockAsapiController = null;
    var sdk = null;

    var tFromNick = "mike";
    var tText = "ello ello ello";
    var tUserId = "@"+sIrcServer+"_"+tFromNick+":"+sHomeServerDomain;

    var checksum = function(str) {
        var total = 0;
        for (var i=0; i<str.length; i++) {
            total += str.charCodeAt(i);
        }
        return total;
    };

    beforeEach(function(done) {
        console.log(" === IRC-to-Matrix Test Start === ");
        ircMock._reset();
        clientMock._reset();
        ircService = proxyquire("../../lib/irc-appservice.js", {
            "matrix-js-sdk": clientMock,
            "irc": ircMock
        });
        mockAsapiController = asapiMock.create();
        sdk = clientMock._client();

        // add registration mock impl:
        // registering should be for the irc user
        sdk.register.andCallFake(function(loginType, data) {
            expect(loginType).toEqual("m.login.application_service");
            expect(data).toEqual({
                user: sIrcServer+"_"+tFromNick
            });
            return q({
                user_id: tUserId
            });
        });

        // do the init
        dbHelper._reset(sDatabaseUri).then(function() {
            ircService.configure(ircConfig);
            return ircService.register(mockAsapiController, serviceConfig);
        }).done(function() {
            done();
        });
    });

    it("should bridge IRC text as Matrix message's m.text", 
    function(done) {
        sdk.sendMessage.andCallFake(function(roomId, content) {
            expect(roomId).toEqual(sRoomId);
            expect(content).toEqual({
                body: tText,
                msgtype: "m.text"
            });
            done();
            return q();
        });

        ircMock._findClientAsync(sIrcServer, sBotNick).done(function(client) {
            client._trigger("message", [tFromNick, sChannel, tText]);
        });
    });

    it("should bridge IRC actions as Matrix message's m.emote", 
    function(done) {
        sdk.sendMessage.andCallFake(function(roomId, content) {
            expect(roomId).toEqual(sRoomId);
            expect(content).toEqual({
                body: tText,
                msgtype: "m.emote"
            });
            done();
            return q();
        });

        ircMock._findClientAsync(sIrcServer, sBotNick).done(function(client) {
            client._trigger("ctcp-privmsg", 
                [tFromNick, sChannel, "ACTION "+tText]
            );
        });
    });

    it("should bridge IRC notices as Matrix message's m.notice", 
    function(done) {
        sdk.sendMessage.andCallFake(function(roomId, content) {
            expect(roomId).toEqual(sRoomId);
            expect(content).toEqual({
                body: tText,
                msgtype: "m.notice"
            });
            done();
            return q();
        });

        ircMock._findClientAsync(sIrcServer, sBotNick).done(function(client) {
            client._trigger("notice", [tFromNick, sChannel, tText]);
        });
    });

    it("should bridge IRC topics as Matrix m.room.topic", 
    function(done) {
        var tTopic = "Topics are liek the best thing evarz!";
        sdk.setRoomTopic.andCallFake(function(roomId, topic) {
            expect(roomId).toEqual(sRoomId);
            expect(topic).toEqual(tTopic);
            done();
            return q();
        });

        ircMock._findClientAsync(sIrcServer, sBotNick).done(function(client) {
            client._trigger("topic", [sChannel, tTopic, tFromNick]);
        });
    });

    it("should bridge IRC formatted text as Matrix's org.matrix.custom.html", 
    function(done) {
        var tIrcFormattedText = "This text is \u0002bold\u000f and this is "+
            "\u001funderlined\u000f and this is \u000303green\u000f. Finally, "+
            "this is a \u0002\u001f\u000303mix of all three";
        var tHtmlCloseTags = "</b></u></font>"; // any order allowed
        var tHtmlMain = "This text is <b>bold</b> and this is <u>underlined</u> "+
            'and this is <font color="green">green</font>. Finally, '+
            'this is a <b><u><font color="green">mix of all three';
        var tHtml = tHtmlMain + tHtmlCloseTags;
        var tFallback = "This text is bold and this is underlined and this is "+
            "green. Finally, this is a mix of all three";
        sdk.sendMessage.andCallFake(function(roomId, content) {
            expect(roomId).toEqual(sRoomId);
            // more readily expose non-printing character errors (looking at
            // you \u000f)
            expect(content.body.length).toEqual(tFallback.length);
            expect(content.body).toEqual(tFallback);
            expect(content.format).toEqual("org.matrix.custom.html");
            expect(content.msgtype).toEqual("m.text");
            expect(content.formatted_body.indexOf(tHtmlMain)).toEqual(0);
            // we allow any order of close tags here, so just do a checksum on
            // the remainder
            expect(
                checksum(content.formatted_body.substring(tHtmlMain.length))
            ).toEqual(
                checksum(tHtmlCloseTags)
            );
            done();
            return q();
        });

        ircMock._findClientAsync(sIrcServer, sBotNick).done(function(client) {
            client._trigger("message", [tFromNick, sChannel, tIrcFormattedText]);
        });
    });
});
