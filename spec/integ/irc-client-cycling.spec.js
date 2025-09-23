/*
 * Tests client-cycling options work correctly.
 */
"use strict";
const envBundle = require("../util/env-bundle");


describe("IRC client cycling", () => {
    let testUsers = null;
    const {env, config, roomMapping, test} = envBundle();

    beforeEach(async () => {
        await test.beforeEach(env);

        // set client cycling to 2 for these tests. This is slightly brittle since we
        // assume that this means when the limit is reached we disconnect a client
        // after a new connection is made (at most 1 above limit).
        config.ircService.servers[roomMapping.server].ircClients.maxClients = 2;

        // make the bot automatically connect and join the mapped channel
        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );
        env.ircMock._autoJoinChannels(
            roomMapping.server, roomMapping.botNick, roomMapping.channel
        );

        testUsers = [
            {
                id: "@alice:hs", nick: "M-alice",
                connects: 0, disconnects: 0, says: 0
            },
            {
                id: "@bob:hs", nick: "M-bob",
                connects: 0, disconnects: 0, says: 0
            },
            {
                id: "@charles:hs", nick: "M-charles",
                connects: 0, disconnects: 0, says: 0
            },
        ];

        testUsers.forEach(function(usr, index) {
            // we'll tally when these clients connect, say or disconnect
            env.ircMock._whenClient(roomMapping.server, usr.nick, "say", (client, channel, text) => {
                testUsers[index].says += 1;
            });
            env.ircMock._whenClient(roomMapping.server, usr.nick, "connect", (client, cb) => {
                testUsers[index].connects += 1;
                client._invokeCallback(cb);
            });
            env.ircMock._whenClient(roomMapping.server, usr.nick, "disconnect", (client, reason, cb) => {
                testUsers[index].disconnects += 1;
                client._invokeCallback(cb);
            });
            // we're not interested in the joins, so autojoin them.
            env.ircMock._autoJoinChannels(
                roomMapping.server, usr.nick, roomMapping.channel
            );
        });

        await test.initEnv(env);
    });

    afterEach(async () => test.afterEach(env));

    it("should disconnect the oldest (last message time) client", async () => {
        await env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "A message",
                msgtype: "m.text"
            },
            user_id: testUsers[0].id,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        });
        await env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "Another message",
                msgtype: "m.text"
            },
            user_id: testUsers[1].id,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        });
        await env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "A third message",
                msgtype: "m.text"
            },
            user_id: testUsers[2].id,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        });
        // everyone should have connected/said something
        let i;
        for (i = 0; i < testUsers.length; i++) {
            expect(testUsers[i].says).toEqual(
                1, testUsers[i].id + " said something"
            );
            expect(testUsers[i].connects).toEqual(
                1, testUsers[i].id + " connected"
            );
        }
        // expect the first 2 people who said something to have disconnected
        // AND NO ONE ELSE.
        expect(testUsers[0].disconnects).toEqual(1,
            "client should have disconnected but didn't");
        expect(testUsers[1].disconnects).toEqual(1,
            "client should have disconnected but didn't");
        for (i = 2; i < testUsers.length; i++) {
            expect(testUsers[i].disconnects).toEqual(
                0, testUsers[i].id + " disconnected");
        }
    });

    it("should reconnect (make a new connection) for a cycled-out client when " +
        "speaking and not use the old disconnected client", async function() {
        await env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "A message",
                msgtype: "m.text"
            },
            user_id: testUsers[0].id,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        });
        await env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "Another message",
                msgtype: "m.text"
            },
            user_id: testUsers[1].id,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        });
        await env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "A third message",
                msgtype: "m.text"
            },
            user_id: testUsers[2].id,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        });
        await env.mockAppService._trigger("type:m.room.message", {
            content: {
                body: "That first guy is back again.",
                msgtype: "m.text"
            },
            user_id: testUsers[0].id,
            room_id: roomMapping.roomId,
            type: "m.room.message"
        });
        // the first guy should have 2 says, 2 connects and 1 disconnect.
        // We're mainly interested in that there were 2 connect calls. If
        // there is just 1, it indicates it used a cached copy.
        const first = testUsers[0];
        expect(first.says).toEqual(2);
        expect(first.connects).withContext("client should 2 connects but doesn't").toEqual(2);
        expect(first.disconnects).withContext("client should 1 disconnects but doesn't").toEqual(1);
    });
});
