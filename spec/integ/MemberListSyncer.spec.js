"use strict";
let test = require("../util/test");
let Promise = require("bluebird");

// set up integration testing mocks
let env = test.mkEnv();

// set up test config
let config = env.config;
let roomMapping = {
    server: config._server,
    botNick: config._botnick,
    channel: config._chan,
    roomId: config._roomid
};

describe("MemberListSyncer", function() {
    let botClient = null;

    beforeEach(test.coroutine(function*() {
        config.ircService.servers[roomMapping.server].membershipLists.enabled = true;
        config.ircService.servers[roomMapping.server].membershipLists.floodDelayMs = 0;
        config.ircService.servers[
            roomMapping.server
        ].membershipLists.global.ircToMatrix.initial = true;
        config.ircService.servers[
            roomMapping.server
        ].membershipLists.global.matrixToIrc.initial = true;
        yield test.beforeEach(this, env); // eslint-disable-line no-invalid-this

        // make the bot automatically connect and join the mapped channel
        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );
        env.ircMock._autoJoinChannels(
            roomMapping.server, roomMapping.botNick, roomMapping.channel
        );

        botClient = env.clientMock._client(config._botUserId);
    }));

    afterEach(test.coroutine(function*() {
        yield test.afterEach(this, env); // eslint-disable-line no-invalid-this
    }));

    it("should sync initial joins from Matrix to IRC", test.coroutine(function*() {
        botClient._http.authedRequestWithPrefix.and.callFake(
        (cb, method, path, qps, data) => {
            if (method === "GET" && path === "/joined_rooms") {
                return Promise.resolve({
                    joined_rooms: [roomMapping.roomId]
                });
            }
            else if (method === "GET" &&
                    path === `/rooms/${encodeURIComponent(roomMapping.roomId)}/joined_members`) {
                return Promise.resolve({
                    joined: {
                        "@alice:bar": {
                            display_name: null,
                            avatar_url: null,
                        },
                        "@bob:bar": {
                            display_name: "Bob",
                            avatar_url: null,
                        }
                    },
                });
            }
            return Promise.reject("unhandled path");
        });

        let aliceNick = "M-alice";
        let bobNick = "M-Bob";
        let aliceJoined = false;
        let bobJoined = false;

        // expect connects and joins for these 2 users
        env.ircMock._whenClient(roomMapping.server, aliceNick, "connect", function(client, cb) {
            client._invokeCallback(cb);
        });
        env.ircMock._whenClient(roomMapping.server, bobNick, "connect", function(client, cb) {
            client._invokeCallback(cb);
        });
        env.ircMock._whenClient(roomMapping.server, aliceNick, "join", function(client, chan, cb) {
            expect(chan).toEqual(roomMapping.channel);
            aliceJoined = true;
            client._invokeCallback(cb);
        });
        env.ircMock._whenClient(roomMapping.server, bobNick, "join", function(client, chan, cb) {
            expect(chan).toEqual(roomMapping.channel);
            bobJoined = true;
            client._invokeCallback(cb);
        });

        yield test.initEnv(env);
        yield Promise.delay(59);
        console.log("FIN");

        expect(aliceJoined).toBe(true, "Alice did not join the channel");
        expect(bobJoined).toBe(true, "Bob did not join the channel");
    }));
});
