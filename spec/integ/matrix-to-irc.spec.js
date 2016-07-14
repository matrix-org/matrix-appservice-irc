/*
 * Contains integration tests for all Matrix-initiated events.
 */
"use strict";
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

describe("Matrix-to-IRC message bridging", function() {
    var testUser = {
        id: "@flibble:wibble",
        nick: "M-flibble"
    };

    beforeEach(function(done) {
        test.beforeEach(this, env); // eslint-disable-line no-invalid-this

        // accept connection requests
        env.ircMock._autoConnectNetworks(
            roomMapping.server, testUser.nick, roomMapping.server
        );
        env.ircMock._autoJoinChannels(
            roomMapping.server, testUser.nick, roomMapping.channel
        );
        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );
        env.ircMock._autoJoinChannels(
            roomMapping.server, roomMapping.botNick, roomMapping.channel
        );

        // do the init
        test.initEnv(env).done(function() {
            done();
        });
    });

    it("should bridge matrix messages as IRC text", function(done) {
        var testText = "Here is some test text.";

        env.ircMock._whenClient(roomMapping.server, testUser.nick, "say",
        function(client, channel, text) {
            expect(client.nick).toEqual(testUser.nick);
            expect(client.addr).toEqual(roomMapping.server);
            expect(channel).toEqual(roomMapping.channel);
            expect(text.length).toEqual(testText.length);
            expect(text).toEqual(testText);
            done();
        });

        env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: testText,
                msgtype: "m.text"
            },
            user_id: testUser.id,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        });
    });

    it("should bridge formatted matrix messages as formatted IRC text",
    function(done) {
        var tFormattedBody = "I support <em>em</em>, <strong>strong bold</strong> and <b>" +
        'normal bold</b> and <b>bold <u>and underline</u><font color="green"> ' +
        "including green</font></b>";
        var tFallback = "I support em, strong bold and normal bold and " +
        "bold and underline including green";
        var tIrcBody = "I support \u001dem\u000f, \u0002strong bold\u000f and \u0002normal bold" +
        "\u000f and \u0002bold \u001fand underline\u000f\u0002\u000303 including" +
        " green\u000f\u0002\u000f"; // last 2 codes not necessary!

        env.ircMock._whenClient(roomMapping.server, testUser.nick, "say",
        function(client, channel, text) {
            expect(client.nick).toEqual(testUser.nick);
            expect(client.addr).toEqual(roomMapping.server);
            expect(channel).toEqual(roomMapping.channel);
            expect(text.length).toEqual(tIrcBody.length);
            expect(text).toEqual(tIrcBody);
            done();
        });

        env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: tFallback,
                format: "org.matrix.custom.html",
                formatted_body: tFormattedBody,
                msgtype: "m.text"
            },
            user_id: testUser.id,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        });
    });

    it("should bridge escaped HTML matrix messages as unescaped HTML",
    function(done) {
        var tFormattedBody = "<p>this is a &quot;test&quot; &amp; some _ mo!re" +
        " fun ch@racters... are &lt; included &gt; here.</p>";
        var tFallback = "this is a \"test\" & some _ mo!re fun ch@racters... " +
        "are < included > here.";
        var tIrcBody = "this is a \"test\" & some _ mo!re fun ch@racters... " +
        "are < included > here.";

        env.ircMock._whenClient(roomMapping.server, testUser.nick, "say",
        function(client, channel, text) {
            expect(client.nick).toEqual(testUser.nick);
            expect(client.addr).toEqual(roomMapping.server);
            expect(channel).toEqual(roomMapping.channel);
            expect(text.length).toEqual(tIrcBody.length);
            expect(text).toEqual(tIrcBody);
            done();
        });

        env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: tFallback,
                format: "org.matrix.custom.html",
                formatted_body: tFormattedBody,
                msgtype: "m.text"
            },
            user_id: testUser.id,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        });
    });

    it("should strip out unknown html tags from formatted_body", function(done) {
        var tFormattedBody = "Here is <foo bar=\"tar\">baz text</foo>";
        var tFallback = "Here is baz text";

        env.ircMock._whenClient(roomMapping.server, testUser.nick, "say",
        function(client, channel, text) {
            expect(client.nick).toEqual(testUser.nick);
            expect(client.addr).toEqual(roomMapping.server);
            expect(channel).toEqual(roomMapping.channel);
            expect(text.length).toEqual(tFallback.length);
            expect(text).toEqual(tFallback);
            done();
        });

        env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: tFallback,
                format: "org.matrix.custom.html",
                formatted_body: tFormattedBody,
                msgtype: "m.text"
            },
            user_id: testUser.id,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        });
    });

    // to prevent formatting text like * from being dropped on the floor IRC side
    it("should use the fallback text if there are unrecognised tags", function(done) {
        var tFormattedBody = "Here is <foo>baz</foo> text";
        var tFallback = "Here is *baz* text";

        env.ircMock._whenClient(roomMapping.server, testUser.nick, "say",
        function(client, channel, text) {
            expect(client.nick).toEqual(testUser.nick);
            expect(client.addr).toEqual(roomMapping.server);
            expect(channel).toEqual(roomMapping.channel);
            expect(text.length).toEqual(tFallback.length);
            expect(text).toEqual(tFallback);
            done();
        });

        env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: tFallback,
                format: "org.matrix.custom.html",
                formatted_body: tFormattedBody,
                msgtype: "m.text"
            },
            user_id: testUser.id,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        });
    });

    it("should bridge matrix emotes as IRC actions", function(done) {
        var testEmote = "thinks";

        env.ircMock._whenClient(roomMapping.server, testUser.nick, "action",
        function(client, channel, text) {
            expect(client.nick).toEqual(testUser.nick);
            expect(client.addr).toEqual(roomMapping.server);
            expect(channel).toEqual(roomMapping.channel);
            expect(text).toEqual(testEmote);
            done();
        });

        env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: testEmote,
                msgtype: "m.emote"
            },
            user_id: testUser.id,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        });
    });

    it("should bridge matrix notices as IRC notices", function(done) {
        var testNotice = "Some automated message";

        env.ircMock._whenClient(roomMapping.server, testUser.nick, "notice",
        function(client, channel, text) {
            expect(client.nick).toEqual(testUser.nick);
            expect(client.addr).toEqual(roomMapping.server);
            expect(channel).toEqual(roomMapping.channel);
            expect(text).toEqual(testNotice);
            done();
        });

        env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: testNotice,
                msgtype: "m.notice"
            },
            user_id: testUser.id,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        });
    });

    it("should bridge matrix images as IRC text with a URL", function(done) {
        var tBody = "the_image.jpg";
        var tMxcSegment = "somedomain.com/somecontentid";
        var tHttpUri = "http://" + tMxcSegment;
        var sdk = env.clientMock._client(config._botUserId);
        sdk.mxcUrlToHttp.andReturn(tHttpUri);

        env.ircMock._whenClient(roomMapping.server, testUser.nick, "say",
        function(client, channel, text) {
            expect(client.nick).toEqual(testUser.nick);
            expect(client.addr).toEqual(roomMapping.server);
            expect(channel).toEqual(roomMapping.channel);
            // don't be too brittle when checking this, but I expect to see the
            // image filename (body) and the http url.
            expect(text.indexOf(tBody)).not.toEqual(-1);
            expect(text.indexOf(tHttpUri)).not.toEqual(-1);
            done();
        });

        env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: tBody,
                url: "mxc://" + tMxcSegment,
                msgtype: "m.image"
            },
            user_id: testUser.id,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        });
    });

    it("should bridge matrix files as IRC text with a URL", function(done) {
        var tBody = "a_file.apk";
        var tMxcSegment = "somedomain.com/somecontentid";
        var tHttpUri = "http://" + tMxcSegment;
        var sdk = env.clientMock._client(config._botUserId);
        sdk.mxcUrlToHttp.andReturn(tHttpUri);

        env.ircMock._whenClient(roomMapping.server, testUser.nick, "say",
        function(client, channel, text) {
            expect(client.nick).toEqual(testUser.nick);
            expect(client.addr).toEqual(roomMapping.server);
            expect(channel).toEqual(roomMapping.channel);
            // don't be too brittle when checking this, but I expect to see the
            // filename (body) and the http url.
            expect(text.indexOf(tBody)).not.toEqual(-1);
            expect(text.indexOf(tHttpUri)).not.toEqual(-1);
            done();
        });

        env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: tBody,
                url: "mxc://" + tMxcSegment,
                msgtype: "m.file"
            },
            user_id: testUser.id,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        });
    });

    it("should bridge matrix topics as IRC topics", function(done) {
        var testTopic = "Topics are amazingz";

        env.ircMock._whenClient(roomMapping.server, testUser.nick, "send",
        function(client, command, channel, data) {
            expect(client.nick).toEqual(testUser.nick);
            expect(client.addr).toEqual(roomMapping.server);
            expect(command).toEqual("TOPIC");
            expect(channel).toEqual(roomMapping.channel);
            expect(data).toEqual(testTopic);
            done();
        });

        env.mockAppService._trigger("type:m.room.topic", {
            content: {
                topic: testTopic
            },
            user_id: testUser.id,
            room_id: roomMapping.roomId,
            state_key: "",
            type: "m.room.topic"
        });
    });
});
