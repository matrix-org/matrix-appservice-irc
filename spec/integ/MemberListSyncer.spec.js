const envBundle = require("../util/env-bundle");

describe("MemberListSyncer", () => {

    const {env, config, roomMapping, test} = envBundle();
    let intent, botClient = null;

    beforeEach(async () => {
        config.ircService.servers[roomMapping.server].membershipLists.enabled = true;
        config.ircService.servers[roomMapping.server].membershipLists.floodDelayMs = 0;
        config.ircService.servers[
            roomMapping.server
        ].membershipLists.global.ircToMatrix.initial = true;
        config.ircService.servers[
            roomMapping.server
        ].membershipLists.global.matrixToIrc.initial = true;
        await test.beforeEach(env);

        // make the bot automatically connect and join the mapped channel
        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );
        env.ircMock._autoJoinChannels(
            roomMapping.server, roomMapping.botNick, roomMapping.channel
        );

        botClient = env.clientMock._client(config._botUserId);
    });

    afterEach(async () => test.afterEach(env));

    it("should sync initial leaves from IRC to Matrix", async () => {
        env.ircMock._autoConnectNetworks(
            roomMapping.server, "M-alice", roomMapping.server
        );
        env.ircMock._whenClient(roomMapping.server, "M-alice", "join", (client, chan, cb) => {
            expect(chan).toEqual(roomMapping.channel);
            client._invokeCallback(cb);
            process.nextTick(() => {
                // send the NAMES
                client.emit("names", chan, {
                    "not_alpha": "",
                    "beta": "",
                });
            });
        });

        const ircUserId = (nick) => `@${roomMapping.server}_${nick}:${config.homeserver.domain}`;

        botClient.getJoinedRooms.and.callFake(() => ([
            roomMapping.roomId,
        ]));

        botClient.getJoinedRoomMembersWithProfiles.and.callFake(() => ({
            "@alice:bar": {},
            [ircUserId("alpha")]: {},
            [ircUserId("beta")]: {},
        }));

        const promise = new Promise((resolve) => {
            // 'alpha' should leave
            const alphaClient = env.clientMock._intent(ircUserId("alpha"));
            alphaClient.leaveRoom.and.callFake((roomId) => {
                expect(roomId).toEqual(roomMapping.roomId);
                resolve();
                return {};
            });
        });

        await test.initEnv(env);
        await promise;
    });

    it("should sync initial joins from Matrix to IRC", async () => {
        botClient.getJoinedRoomMembersWithProfiles.and.callFake(() => {
            return Promise.resolve({
                "@alice:bar": {
                    display_name: null,
                    avatar_url: null,
                },
                "@bob:bar": {
                    display_name: "Bob",
                    avatar_url: null,
                }
            });
        });
        botClient.getJoinedRooms.and.callFake(() => ({joined_rooms: [roomMapping.roomId]}));
        const alicePromise = new Promise((resolve, reject) => {
            const aliceNick = "M-alice";
            env.ircMock._whenClient(roomMapping.server, aliceNick, "connect", function(client, cb) {
                client._invokeCallback(cb);
            });
            env.ircMock._whenClient(roomMapping.server, aliceNick, "join", (client, chan, cb) => {
                expect(chan).toEqual(roomMapping.channel);
                resolve();
                client._invokeCallback(cb);
            });
        });

        const bobPromise = new Promise((resolve, reject) => {
            const bobNick = "M-Bob";
            env.ircMock._whenClient(roomMapping.server, bobNick, "connect", function(client, cb) {
                client._invokeCallback(cb);
            });
            env.ircMock._whenClient(roomMapping.server, bobNick, "join", (client, chan, cb) => {
                expect(chan).toEqual(roomMapping.channel);
                resolve();
                client._invokeCallback(cb);
            });
        });

        await test.initEnv(env);
        await Promise.all([alicePromise, bobPromise]);
    });
});
