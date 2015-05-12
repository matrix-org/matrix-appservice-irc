/*
 * Tests IRC connections are managed correctly.
 */
"use strict";
var test = require("../util/test");
var q = require("q");

// set up integration testing mocks
var env = test.mkEnv();

// set up test config
var appConfig = env.appConfig;
var roomMapping = appConfig.roomMapping;

describe("IRC connections", function() {
    var testUser = {
        id: "@alice:hs",
        nick: "M-alice"
    };

    beforeEach(function(done) {
        test.beforeEach(this, env);

        // make the bot automatically connect and join the mapped channel
        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );
        env.ircMock._autoJoinChannels(
            roomMapping.server, roomMapping.botNick, roomMapping.channel
        );

        // we're not interested in the joins, so autojoin them.
        env.ircMock._autoJoinChannels(
            roomMapping.server, testUser.nick, roomMapping.channel
        );

        // do the init
        test.initEnv(env).done(function() {
            done();
        });
    });

    it("should be made once per client, regardless of how many messages are "+
    "to be sent to IRC", function(done) {
        var connectCount = 0;

        env.ircMock._whenClient(roomMapping.server, testUser.nick, "connect", 
        function(client, cb) {
            connectCount += 1;
            // add an artificially long delay to make sure it isn't connecting
            // twice
            setTimeout(function() {
                client._invokeCallback(cb);
            }, 500);
        });

        var promises = [];

        promises.push(env.mockAsapiController._trigger("type:m.room.message", {
            content: {
                body: "A message",
                msgtype: "m.text"
            },
            user_id: testUser.id,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        }));

        promises.push(env.mockAsapiController._trigger("type:m.room.message", {
            content: {
                body: "Another message",
                msgtype: "m.text"
            },
            user_id: testUser.id,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        }));

        q.all(promises).done(function() {
            expect(connectCount).toBe(1);
            done();
        });
    });
});