/*
 * Contains integration tests for all IRC-initiated events.
 */
"use strict";
var Promise = require("bluebird");
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

describe("IRC-to-Matrix message bridging", function() {
    var sdk = null;

    var tFromNick = "mike";
    var tUserId = "@" + roomMapping.server + "_" + tFromNick + ":" +
                  config.homeserver.domain;

    var checksum = function(str) {
        var total = 0;
        for (var i = 0; i < str.length; i++) {
            total += str.charCodeAt(i);
        }
        return total;
    };

    beforeEach(test.coroutine(function*() {
        yield test.beforeEach(env);

        sdk = env.clientMock._client(tUserId);
        // add registration mock impl:
        // registering should be for the irc user
        sdk._onHttpRegister({
            expectLocalpart: roomMapping.server + "_" + tFromNick,
            returnUserId: tUserId
        });

        env.ircMock._autoJoinChannels(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );
        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );

        // do the init
        yield test.initEnv(env);
    }));

    afterEach(test.coroutine(function*() {
        yield test.afterEach(env);
    }));

    it("should bridge IRC text as Matrix message's m.text",
    function(done) {
        var testText = "this is some test text.";
        sdk.sendEvent.and.callFake(function(roomId, type, content) {
            expect(roomId).toEqual(roomMapping.roomId);
            expect(content).toEqual({
                body: testText,
                msgtype: "m.text"
            });
            done();
            return Promise.resolve();
        });

        env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(
        function(client) {
            client.emit("message", tFromNick, roomMapping.channel, testText);
        });
    });

    it("should bridge IRC actions as Matrix message's m.emote",
    function(done) {
        var testEmoteText = "thinks for a bit";
        sdk.sendEvent.and.callFake(function(roomId, type, content) {
            expect(roomId).toEqual(roomMapping.roomId);
            expect(content).toEqual({
                body: testEmoteText,
                msgtype: "m.emote"
            });
            done();
            return Promise.resolve();
        });

        env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(
        function(client) {
            client.emit("ctcp-privmsg",
                tFromNick, roomMapping.channel, "ACTION " + testEmoteText
            );
        });
    });

    it("should bridge IRC notices as Matrix message's m.notice",
    function(done) {
        var testNoticeText = "Automated bot text: SUCCESS!";
        sdk.sendEvent.and.callFake(function(roomId, type, content) {
            expect(roomId).toEqual(roomMapping.roomId);
            expect(content).toEqual({
                body: testNoticeText,
                msgtype: "m.notice"
            });
            done();
            return Promise.resolve();
        });

        env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(
        function(client) {
            client.emit(
                "notice", tFromNick, roomMapping.channel, testNoticeText
            );
        });
    });

    it("should bridge IRC topics as Matrix m.room.topic in aliased rooms",
    test.coroutine(function*() {
        var testTopic = "Topics are liek the best thing evarz!";

        var tChannel = "#someotherchannel";
        var tRoomId = roomMapping.roomId;
        var tServer = roomMapping.server;
        var tBotNick = roomMapping.botNick;

        // Use bot client for mocking responses
        var cli = env.clientMock._client(config._botUserId);

        yield cli._setupRoomByAlias(
            env, tBotNick, tChannel, tRoomId, tServer, config.homeserver.domain
        );

        let p = new Promise((resolve, reject) => {
            cli.sendStateEvent.and.callFake(function(roomId, type, content, skey) {
                expect(roomId).toEqual(roomMapping.roomId);
                expect(content).toEqual({ topic: testTopic });
                expect(type).toEqual("m.room.topic");
                expect(skey).toEqual("");
                resolve();
                return Promise.resolve();
            });
        });

        let client = yield env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick);
        client.emit("topic", tChannel, testTopic, tFromNick);

        yield p;
    }));

    it("should be insensitive to the case of the channel",
    function(done) {
        var testText = "this is some test text.";
        sdk.sendEvent.and.callFake(function(roomId, type, content) {
            expect(roomId).toEqual(roomMapping.roomId);
            expect(content).toEqual({
                body: testText,
                msgtype: "m.text"
            });
            done();
            return Promise.resolve();
        });

        env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(
        function(client) {
            client.emit(
                "message", tFromNick, roomMapping.channel.toUpperCase(), testText
            );
        });
    });

    it("should bridge IRC formatted text as Matrix's org.matrix.custom.html",
    function(done) {
        var tIrcFormattedText = "This text is \u0002bold\u000f and this is " +
            "\u001funderlined\u000f and this is \u000303green\u000f. Finally, " +
            "this is a \u0002\u001f\u000303mix of all three";
        var tHtmlCloseTags = "</b></u></font>"; // any order allowed
        var tHtmlMain = "This text is <b>bold</b> and this is <u>underlined</u> " +
            'and this is <font color="green">green</font>. Finally, ' +
            'this is a <b><u><font color="green">mix of all three';
        var tFallback = "This text is bold and this is underlined and this is " +
            "green. Finally, this is a mix of all three";
        sdk.sendEvent.and.callFake(function(roomId, type, content) {
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
            return Promise.resolve();
        });

        env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(
        function(client) {
            client.emit(
                "message", tFromNick, roomMapping.channel, tIrcFormattedText
            );
        });
    });

    it("should bridge badly formatted IRC text as Matrix's org.matrix.custom.html",
    function(done) {
        var tIrcFormattedText = "\u0002hello \u001d world\u0002 ! \u001d";
        var tHtmlMain = "<b>hello <i> world</b> ! </i>";
        var tFallback = "hello  world ! ";
        sdk.sendEvent.and.callFake(function(roomId, type, content) {
            expect(roomId).toEqual(roomMapping.roomId);
            // more readily expose non-printing character errors (looking at
            // you \u000f)
            expect(content.body.length).toEqual(tFallback.length);
            expect(content.body).toEqual(tFallback);
            expect(content.format).toEqual("org.matrix.custom.html");
            expect(content.msgtype).toEqual("m.text");
            expect(content.formatted_body.indexOf(tHtmlMain)).toEqual(0);
            done();
            return Promise.resolve();
        });

        env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(
        function(client) {
            client.emit(
                "message", tFromNick, roomMapping.channel, tIrcFormattedText
            );
        });
    });

    it("should bridge special regex character formatted IRC colours as Matrix's" +
    "org.matrix.custom.html", function(done) {
        // $& = Inserts the matched substring.
        var tIrcFormattedText = "\u000303$& \u000304 world\u000303 ! \u000304";
        var tHtmlMain = '<font color="green">$&amp; </font><font color="red"> world'+
            '</font><font color="green"> ! </font>';
        var tFallback = "$&  world ! ";
        sdk.sendEvent.and.callFake(function(roomId, type, content) {
            expect(roomId).toEqual(roomMapping.roomId);
            // more readily expose non-printing character errors (looking at
            // you \u000f)
            expect(content.body.length).toEqual(tFallback.length);
            expect(content.body).toEqual(tFallback);
            expect(content.format).toEqual("org.matrix.custom.html");
            expect(content.msgtype).toEqual("m.text");
            expect(content.formatted_body.indexOf(tHtmlMain)).toEqual(0);
            done();
            return Promise.resolve();
        });

        env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(
        function(client) {
            client.emit(
                "message", tFromNick, roomMapping.channel, tIrcFormattedText
            );
        });
    });

    it("should html escape IRC text", function(done) {
        var tIrcFormattedText = "This text is \u0002bold\u000f and has " +
            "<div> tags & characters like ' and \"";
        var tHtmlMain = "This text is <b>bold</b> and has " +
            "&lt;div&gt; tags &amp; characters like &#39; and &quot;";
        var tFallback = "This text is bold and has <div> tags & characters like ' and \"";
        sdk.sendEvent.and.callFake(function(roomId, type, content) {
            expect(roomId).toEqual(roomMapping.roomId);
            // more readily expose non-printing character errors (looking at
            // you \u000f)
            expect(content.body.length).toEqual(tFallback.length);
            expect(content.body).toEqual(tFallback);
            expect(content.format).toEqual("org.matrix.custom.html");
            expect(content.msgtype).toEqual("m.text");
            expect(content.formatted_body).toEqual(tHtmlMain);
            done();
            return Promise.resolve();
        });

        env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(
        function(client) {
            client.emit(
                "message", tFromNick, roomMapping.channel, tIrcFormattedText
            );
        });
    });

    it("should toggle on IRC formatting flags", function(done) {
        var tIrcFormattedText = "This text is \u0002bold\u0002 and \u0002\u0002thats it.";
        var tHtmlMain = "This text is <b>bold</b> and <b></b>thats it.";
        var tFallback = "This text is bold and thats it.";
        sdk.sendEvent.and.callFake(function(roomId, type, content) {
            expect(roomId).toEqual(roomMapping.roomId);
            // more readily expose non-printing character errors (looking at
            // you \u000f)
            expect(content.body.length).toEqual(tFallback.length);
            expect(content.body).toEqual(tFallback);
            expect(content.format).toEqual("org.matrix.custom.html");
            expect(content.msgtype).toEqual("m.text");
            expect(content.formatted_body).toEqual(tHtmlMain);
            done();
            return Promise.resolve();
        });

        env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(
        function(client) {
            client.emit(
                "message", tFromNick, roomMapping.channel, tIrcFormattedText
            );
        });
    });
});

describe("IRC-to-Matrix operator modes bridging", function() {
    let botMatrixClient = null;

    var tRealMatrixUserNick = "M-alice";
    var tRealUserId = "@alice:anotherhomeserver";

    beforeEach(test.coroutine(function*() {
        yield test.beforeEach(env);

        botMatrixClient = env.clientMock._client(config._botUserId);

        env.ircMock._autoJoinChannels(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );
        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );

        env.ircMock._autoConnectNetworks(
            roomMapping.server, tRealMatrixUserNick, roomMapping.server
        );

        env.ircMock._autoJoinChannels(
            roomMapping.server, tRealMatrixUserNick, roomMapping.channel
        );

        // do the init
        yield test.initEnv(env).then(() => {
            return env.mockAppService._trigger("type:m.room.message", {
                content: {
                    body: "get me in",
                    msgtype: "m.text"
                },
                user_id: tRealUserId,
                room_id: roomMapping.roomId,
                type: "m.room.message"
            });
        });
    }));

    afterEach(test.coroutine(function*() {
        yield test.afterEach(env);
    }));

    it("should bridge modes to power levels",
    test.coroutine(function*() {
        // Set IRC user prefix, which in reality is assumed to have happened
        const client = yield env.ircMock._findClientAsync(roomMapping.server, tRealMatrixUserNick);

        client.chans[roomMapping.channel] = {
            users: {
                [tRealMatrixUserNick]: "@"
            }
        };

        const promise = new Promise((resolve, reject) => {
            botMatrixClient.setPowerLevel.and.callFake(
            function(roomId, userId, powerLevel, event, callback) {
                expect(roomId).toBe(roomMapping.roomId);
                expect(userId).toBe(tRealUserId);
                expect(powerLevel).toBe(50);
                resolve();
                return Promise.resolve();
            });

            env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(
            function(cli) {
                cli.emit(
                    "+mode", roomMapping.channel, "op-er", "o", tRealMatrixUserNick, "here you go"
                );
            });
        });

        yield promise;
    }));

    it("should bridge the highest power of multiple modes",
    test.coroutine(function*() {
        // Set IRC user prefix, which in reality is assumed to have happened
        const client = yield env.ircMock._findClientAsync(roomMapping.server, tRealMatrixUserNick);

        // This test simulates MODE +o being received, when the user had previously already had
        // a prefix of "+". So their prefix is updated to "+@", as per node-irc. The expected
        // result is that they should be given power of 50 (= +o).
        client.chans[roomMapping.channel] = {
            users: {
                [tRealMatrixUserNick]: "+@"
            }
        };

        const promise = new Promise((resolve, reject) => {
            botMatrixClient.setPowerLevel.and.callFake(
            function(roomId, userId, powerLevel, event, callback) {
                expect(roomId).toBe(roomMapping.roomId);
                expect(userId).toBe(tRealUserId);
                expect(powerLevel).toBe(50);
                resolve();
                return Promise.resolve();
            });

            env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(
            function(cli) {
                cli.emit(
                    "+mode", roomMapping.channel, "op-er", "o", tRealMatrixUserNick, "here you go"
                );
            });
        });

        yield promise;
    }));

    it("should bridge the highest power of multiple modes when a higher power mode is removed",
    test.coroutine(function*() {
        // Set IRC user prefix, which in reality is assumed to have happened
        const client = yield env.ircMock._findClientAsync(roomMapping.server, tRealMatrixUserNick);

        // This test simulates MODE -o being received, when the user had previously already had
        // a prefix of "+@". So their prefix is updated to "+", as per node-irc. The expected
        // result is that they should be given power of 25 (= +v).
        client.chans[roomMapping.channel] = {
            users: {
                [tRealMatrixUserNick]: "+"
            }
        };

        const promise = new Promise((resolve, reject) => {
            botMatrixClient.setPowerLevel.and.callFake(
            function(roomId, userId, powerLevel, event, callback) {
                expect(roomId).toBe(roomMapping.roomId);
                expect(userId).toBe(tRealUserId);
                expect(powerLevel).toBe(25);
                resolve();
                return Promise.resolve();
            });

            env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(
            function(cli) {
                cli.emit(
                    "-mode", roomMapping.channel, "op-er", "o", tRealMatrixUserNick, "here you go"
                );
            });
        });

        yield promise;
    }));

    it("should bridge the highest power of multiple modes when a lower power mode is removed",
    test.coroutine(function*() {
        // Set IRC user prefix, which in reality is assumed to have happened
        const client = yield env.ircMock._findClientAsync(roomMapping.server, tRealMatrixUserNick);

        // This test simulates MODE -v being received, when the user had previously already had
        // a prefix of "+@". So their prefix is updated to "@", as per node-irc. The expected
        // result is that they should be given power of 50 (= +o).
        client.chans[roomMapping.channel] = {
            users: {
                [tRealMatrixUserNick]: "@"
            }
        };

        const promise = new Promise((resolve, reject) => {
            botMatrixClient.setPowerLevel.and.callFake(
            function(roomId, userId, powerLevel, event, callback) {
                expect(roomId).toBe(roomMapping.roomId);
                expect(userId).toBe(tRealUserId);
                expect(powerLevel).toBe(50);
                resolve();
                return Promise.resolve();
            });

            env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(
            function(cli) {
                cli.emit(
                    "-mode", roomMapping.channel, "op-er", "v", tRealMatrixUserNick, "here you go"
                );
            });
        });

        yield promise;
    }));
});

describe("IRC-to-Matrix name bridging", function() {
    var sdk;
    var tFromNick = "mike";
    var tUserId = "@" + roomMapping.server + "_" + tFromNick + ":" +
                  config.homeserver.domain;

    beforeEach(test.coroutine(function*() {
        yield test.beforeEach(env);

        config.ircService.servers[roomMapping.server].matrixClients.displayName = (
            "Test $NICK and $SERVER"
        );
        config.ircService.servers[roomMapping.server].membershipLists.enabled = true;
        config.ircService.servers[
            roomMapping.server
        ].membershipLists.global.ircToMatrix.initial = true;

        sdk = env.clientMock._client(tUserId);

        env.ircMock._autoJoinChannels(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );
        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );

        yield test.initEnv(env);
    }));

    afterEach(test.coroutine(function*() {
        yield test.afterEach(env);
    }));

    it("should set the matrix display name from the config file template", function(done) {
        // don't care about registration / sending the event
        sdk.sendEvent.and.callFake(function(roomId, type, content) {
            return Promise.resolve();
        });
        sdk.register.and.callFake(function(username, password) {
            return Promise.resolve({
                user_id: tUserId
            });
        });

        sdk.setDisplayName.and.callFake(function(name) {
            expect(name).toEqual("Test mike and " + roomMapping.server);
            done();
        });

        env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(
        function(client) {
            client.emit("message", tFromNick, roomMapping.channel, "ping");
        });
    });

    it("should process all NAMEs entries", function(done) {
        var nicks = {
            Alicia: {
                uid: "@" + roomMapping.server + "_Alicia:" + config.homeserver.domain,
            },
            Bertha: {
                uid: "@" + roomMapping.server + "_Bertha:" + config.homeserver.domain,
            },
            Clarissa: {
                uid: "@" + roomMapping.server + "_Clarissa:" + config.homeserver.domain,
            }
        };

        var joined = new Set();
        Object.keys(nicks).forEach(function(n) {
            var cli = env.clientMock._client(nicks[n].uid);
            cli._onHttpRegister({
                expectLocalpart: roomMapping.server + "_" + n,
                returnUserId: nicks[n].uid
            });
            cli.joinRoom.and.callFake(function(r, opts) {
                expect(r).toEqual(roomMapping.roomId);
                joined.add(n);
                if (joined.size === 3) {
                    done();
                }
                return Promise.resolve({room_id: r});
            });

            // don't care about display name
            cli.setDisplayName.and.callFake(function(name) {
                return Promise.resolve({});
            });
        });

        env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(
        function(client) {
            var names = {
                Alicia: {},
                Bertha: {},
                Clarissa: {}
            };
            client.emit("names", roomMapping.channel, names);
        });
    });
});
