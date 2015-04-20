/*
 * Tests client-cycling options work correctly.
 */
"use strict";
var q = require("q");
var test = require("../util/test");

// set up integration testing mocks
var env = test.mkEnv();

// set up test config
var appConfig = env.appConfig;
var roomMapping = appConfig.roomMapping;

// set client cycling to 3 for these tests. This is slightly brittle since we
// assume that this means when the limit is reached we disconnect a client
// immediately (to always keep 1 below the limit).
appConfig.ircConfig.servers[roomMapping.server].ircClients.maxClients = 3;


describe("IRC client cycling", function() {
    var testUsers = null;

    beforeEach(function(done) {
        test.beforeEach(this, env);

        // make the bot automatically connect and join the mapped channel
        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );
        env.ircMock._autoJoinChannels(
            roomMapping.server, roomMapping.botNick, roomMapping.channel
        );

        testUsers = [
            {
                id: "@alice:hs", nick:"M-alice",
                connects:0, disconnects:0, says:0
            },
            {
                id: "@bob:hs", nick:"M-bob",
                connects:0, disconnects:0, says:0
            },
            {
                id: "@charles:hs", nick:"M-charles",
                connects:0, disconnects:0, says:0
            }
        ];

        testUsers.forEach(function(usr, index) {
            // we'll tally when these clients connect, say or disconnect
            env.ircMock._whenClient(roomMapping.server, usr.nick, "say", 
            function(client, channel, text) {
                testUsers[index].says += 1;
            });
            env.ircMock._whenClient(roomMapping.server, usr.nick, "connect", 
            function(client, cb) {
                testUsers[index].connects += 1;
                client._invokeCallback(cb);
            });
            env.ircMock._whenClient(roomMapping.server, usr.nick, "disconnect", 
            function(client, reason, cb) {
                testUsers[index].disconnects += 1;
                client._invokeCallback(cb);
            });
            // we're not interested in the joins, so autojoin them.
            env.ircMock._autoJoinChannels(
                roomMapping.server, usr.nick, roomMapping.channel
            );
        });

        // do the init
        test.initEnv(env).done(function() {
            done();
        });
    });

    it("should disconnect the oldest (last message time) client", 
    function(done) {
        env.mockAsapiController._trigger("type:m.room.message", {
            content: {
                body: "A message",
                msgtype: "m.text"
            },
            user_id: testUsers[0].id,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        }).then(function() {
            return env.mockAsapiController._trigger("type:m.room.message", {
                content: {
                    body: "Another message",
                    msgtype: "m.text"
                },
                user_id: testUsers[1].id,
                room_id: roomMapping.roomId,
                type: "m.room.message"
            });
        }).then(function() {
            return env.mockAsapiController._trigger("type:m.room.message", {
                content: {
                    body: "A third message",
                    msgtype: "m.text"
                },
                user_id: testUsers[2].id,
                room_id: roomMapping.roomId,
                type: "m.room.message"
            });
        }).done(function() {
            // everyone should have connected/said something
            for (var i=0; i<testUsers.length; i++) {
                expect(testUsers[i].says).toEqual(
                    1, testUsers[i].id+" said something"
                );
                expect(testUsers[i].connects).toEqual(
                    1, testUsers[i].id+" connected"
                );
            }
            // expect the first person who said something to have disconnected
            // AND NO ONE ELSE.
            expect(testUsers[0].disconnects).toEqual(1);
            for (i=1; i<testUsers.length; i++) {
                expect(testUsers[i].disconnects).toEqual(
                    0, testUsers[i].id+" disconnected");
            }
            done();
        });
    });

    it("should reconnect (make a new connection) for a cycled-out client when "+
        "speaking and not use the old disconnected client", function(done) {
        env.mockAsapiController._trigger("type:m.room.message", {
            content: {
                body: "A message",
                msgtype: "m.text"
            },
            user_id: testUsers[0].id,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        }).then(function() {
            return env.mockAsapiController._trigger("type:m.room.message", {
                content: {
                    body: "Another message",
                    msgtype: "m.text"
                },
                user_id: testUsers[1].id,
                room_id: roomMapping.roomId,
                type: "m.room.message"
            });
        }).then(function() {
            return env.mockAsapiController._trigger("type:m.room.message", {
                content: {
                    body: "A third message",
                    msgtype: "m.text"
                },
                user_id: testUsers[2].id,
                room_id: roomMapping.roomId,
                type: "m.room.message"
            });
        }).then(function() {
            return env.mockAsapiController._trigger("type:m.room.message", {
                content: {
                    body: "That first guy is back again.",
                    msgtype: "m.text"
                },
                user_id: testUsers[0].id,
                room_id: roomMapping.roomId,
                type: "m.room.message"
            });
        }).done(function() {
            // the first guy should have 2 says, 2 connects and 1 disconnect.
            // We're mainly interested in that there were 2 connect calls. If
            // there is just 1, it indicates it used a cached copy.
            var first = testUsers[0];
            expect(first.says).toEqual(2);
            expect(first.connects).toEqual(2);
            expect(first.disconnects).toEqual(1);
            done();
        });
    });
});