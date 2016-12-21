/*
 * Contains integration tests for all Startup-initiated events.
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

describe("Initialisation", function() {
    var ircAddr = roomMapping.server;
    var ircNick = roomMapping.botNick;
    var ircChannel = roomMapping.channel;

    beforeEach(test.coroutine(function*() {
        yield test.beforeEach(env);
    }));

    afterEach(test.coroutine(function*() {
        yield test.afterEach(env);
    }));

    it("should connect to the IRC network and channel in the config",
    function(done) {
        var clientConnected = false;
        var clientJoined = false;

        env.ircMock._whenClient(ircAddr, ircNick, "connect",
        function(client, fn) {
            expect(clientJoined).toBe(false, "Joined before connect call");
            clientConnected = true;
            fn();
        });


        env.ircMock._whenClient(ircAddr, ircNick, "join",
        function(client, chan, fn) {
            expect(chan).toEqual(ircChannel);
            expect(clientConnected).toBe(true, "Didn't connect before join call");
            clientJoined = true;
            done();
        });

        // run the test
        test.initEnv(env);
    });

    it("[BOTS-70] should attempt to set the bot nick if ircd assigned random string",
    function(done) {
        var assignedNick = "5EXABJ6GG";

        // let the bot connect
        env.ircMock._whenClient(roomMapping.server, ircNick, "connect",
        function(client, cb) {
            // after the connect callback, modify their nick and emit an event.
            client._invokeCallback(cb).done(function() {
                process.nextTick(function() {
                    client.nick = assignedNick;
                    client.emit("nick", ircNick, assignedNick);
                    done();
                });
            });
        });

        env.ircMock._whenClient(roomMapping.server, ircNick, "send",
        function(client, command, arg) {
            expect(client.nick).toEqual(ircNick, "use the old nick on /nick");
            expect(client.addr).toEqual(roomMapping.server);
            expect(command).toEqual("NICK");
            expect(arg).toEqual(ircNick);
            done();
        });

        // run the test
        test.initEnv(env);
    });
});
