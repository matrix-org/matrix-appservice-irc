/*
 * Contains integration tests for all IRC-initiated events.
 */
"use strict";
var q = require("q");

// set up integration testing mocks
var proxyquire =  require('proxyquire');
var clientMock = require("../util/client-sdk-mock");
clientMock["@global"] = true; 
var ircMock = require("../util/irc-mock");
ircMock["@global"] = true;
var dbHelper = require("../util/db-helper");
var asapiMock = require("../util/asapi-controller-mock");

// set up test config
var appConfig = require("../util/config-mock");
var roomMapping = appConfig.roomMapping;

describe("IRC-to-Matrix message bridging", function() {
    var ircService = null;
    var mockAsapiController = null;
    var sdk = null;

    var tFromNick = "mike";
    var tUserId = "@"+roomMapping.server+"_"+tFromNick+":"+
                  appConfig.homeServerDomain;

    var checksum = function(str) {
        var total = 0;
        for (var i=0; i<str.length; i++) {
            total += str.charCodeAt(i);
        }
        return total;
    };

    beforeEach(function(done) {
        console.log(" === IRC-to-Matrix Test Start === ");
        // instantiate mocks
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
        sdk._onHttpRegister({
            expectLocalpart: roomMapping.server+"_"+tFromNick, 
            returnUserId: tUserId
        });

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

    it("should bridge IRC text as Matrix message's m.text", 
    function(done) {
        var testText = "this is some test text.";
        sdk.sendMessage.andCallFake(function(roomId, content) {
            expect(roomId).toEqual(roomMapping.roomId);
            expect(content).toEqual({
                body: testText,
                msgtype: "m.text"
            });
            done();
            return q();
        });

        ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(
        function(client) {
            client._trigger("message", [tFromNick, roomMapping.channel, testText]);
        });
    });

    it("should bridge IRC actions as Matrix message's m.emote", 
    function(done) {
        var testEmoteText = "thinks for a bit";
        sdk.sendMessage.andCallFake(function(roomId, content) {
            expect(roomId).toEqual(roomMapping.roomId);
            expect(content).toEqual({
                body: testEmoteText,
                msgtype: "m.emote"
            });
            done();
            return q();
        });

        ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(function(client) {
            client._trigger("ctcp-privmsg", 
                [tFromNick, roomMapping.channel, "ACTION "+testEmoteText]
            );
        });
    });

    it("should bridge IRC notices as Matrix message's m.notice", 
    function(done) {
        var testNoticeText = "Automated bot text: SUCCESS!";
        sdk.sendMessage.andCallFake(function(roomId, content) {
            expect(roomId).toEqual(roomMapping.roomId);
            expect(content).toEqual({
                body: testNoticeText,
                msgtype: "m.notice"
            });
            done();
            return q();
        });

        ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(function(client) {
            client._trigger("notice", [tFromNick, roomMapping.channel, testNoticeText]);
        });
    });

    it("should bridge IRC topics as Matrix m.room.topic", 
    function(done) {
        var testTopic = "Topics are liek the best thing evarz!";
        sdk.setRoomTopic.andCallFake(function(roomId, topic) {
            expect(roomId).toEqual(roomMapping.roomId);
            expect(topic).toEqual(testTopic);
            done();
            return q();
        });

        ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(function(client) {
            client._trigger("topic", [roomMapping.channel, testTopic, tFromNick]);
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
            expect(roomId).toEqual(roomMapping.roomId);
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

        ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(function(client) {
            client._trigger("message", [tFromNick, roomMapping.channel, tIrcFormattedText]);
        });
    });
});
