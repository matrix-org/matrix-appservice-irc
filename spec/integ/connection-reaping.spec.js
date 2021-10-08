const envBundle = require("../util/env-bundle");

describe("Connection reaping", () => {
    const testUser = {
        id: "@flibble:wibble",
        nick: "flibble"
    };
    const {env, roomMapping, test} = envBundle();
    let defaultOnline;

    env.config.ircService.debugApi.enabled = true;
    beforeEach(async () => {
        await test.beforeEach(env);

        env.ircMock._autoConnectNetworks(
            roomMapping.server, testUser.nick, roomMapping.server
        );
        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );
        env.ircMock._autoJoinChannels(
            roomMapping.server, testUser.nick, roomMapping.channel
        );

        await test.initEnv(env);
        defaultOnline = env.ircBridge.activityTracker.opts.defaultOnline;
        // For the purposes of these tests, we want to ensure that the activity tracker defaults to false.
        env.ircBridge.activityTracker.opts.defaultOnline = false;
    });

    afterEach(async () => test.afterEach(env));

    it("users should appear online by default", async () => {
        // Revert to the default value for this one test
        env.ircBridge.activityTracker.opts.defaultOnline = defaultOnline;
        const res = await env.ircBridge.activityTracker.isUserOnline(testUser.id, 1000);
        expect(res.online).toBeTruthy();
        expect(res.inactiveMs).toBe(-1);
    });

    it("users should appear offline if they haven't sent any messages", async () => {
        const res = await env.ircBridge.activityTracker.isUserOnline(testUser.id, 1000);
        expect(res.online).toBeFalsy();
        expect(res.inactiveMs).toBe(-1);
    });

    it("users should appear online if they have sent a message", async () => {
        await env.mockAppService._trigger("type:foo.notamessage", {
            content: {
                body: "foo",
                msgtype: "m.text",
            },
            sender: testUser.id,
            room_id: roomMapping.roomId,
            type: "foo.notamessage",
        });
        const res = await env.ircBridge.activityTracker.isUserOnline(testUser.id, 10000);
        expect(res.online).toBeTruthy();
        expect(res.inactiveMs).toBeLessThanOrEqual(5000);
    });

    it("users last active status should be stored in the database", async () => {
        const ts = Date.now();
        await env.mockAppService._trigger("type:foo.notamessage", {
            content: {
                body: "foo",
                msgtype: "m.text",
            },
            sender: testUser.id,
            room_id: roomMapping.roomId,
            type: "foo.notamessage",
        });
        const users = await env.ircBridge.getStore().getLastSeenTimeForUsers();
        expect(users[0].user_id).toBe("@flibble:wibble");
        expect(users[0].ts).toBeGreaterThanOrEqual(ts);
    });
});
