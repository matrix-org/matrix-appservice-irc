const envBundle = require("../util/env-bundle");

describe("Homeserver user queries", () => {
    const {env, config, roomMapping, test} = envBundle();

    const testNick = "Alisha";
    const testLocalpart = roomMapping.server + "_" + testNick;
    const testUserId = `@${testLocalpart}:${config.homeserver.domain}`;

    beforeEach(async () => {
        await test.beforeEach(env);

        // accept connection requests
        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );

        await test.initEnv(env);
    });

    afterEach(async () => test.afterEach(env));

    it("should always create a new Matrix user for the specified ID", (done) => {
        const sdk = env.clientMock._intent(config._botUserId);

        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "whois", (_client, nick, cb) => {
            expect(nick).toEqual(testNick);
            // say they exist (presence of user key)
            cb({
                user: testNick,
                nick: testNick
            });
        });

        sdk._onHttpRegister({
            expectLocalpart: testLocalpart,
            returnUserId: testUserId
        });

        env.mockAppService._queryUser(testUserId).then(done);
    });
});

describe("Homeserver alias queries", function() {
    const {env, config, roomMapping, test} = envBundle();
    const testChannel = "#tower";
    const testLocalpart = "irc_" + roomMapping.server + "_" + testChannel;
    const testAlias = (
        "#" + testLocalpart + ":" + config.homeserver.domain
    );

    beforeEach(async () => {
        await test.beforeEach(env);

        // accept connection requests
        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );

        try {
            await test.initEnv(env);
        }
        catch (err) {
            console.error(err);
            expect(false).toBe(true, "onUserQuery failed request.");
        }
    });

    afterEach(async () => test.afterEach(env));

    it("should make the AS start tracking the channel specified in the alias.", async () => {
        const sdk = env.clientMock._client(config._botUserId);
        sdk.createRoom.and.callFake(({room_alias_name, visibility}) => {
            expect(room_alias_name).toEqual(testLocalpart);
            expect(visibility).toEqual("private");
            return "!something:somewhere";
        });

        sdk.sendStateEvent.and.callFake((roomId, eventType, _key, obj) => {
            expect(eventType).toEqual("m.room.history_visibility");
            expect(obj).toEqual({history_visibility: "joined"});
            return Promise.resolve({});
        });

        let botJoined = false;
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "join", (client, channel, cb) => {
            if (channel === testChannel) {
                botJoined = true;
                client._invokeCallback(cb);
            }
        });

        await env.mockAppService._queryAlias(testAlias);
        expect(botJoined).withContext("Bot didn't join " + testChannel).toBeTrue();
    });
});
