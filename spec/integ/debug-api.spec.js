const envBundle = require("../util/env-bundle");
const request = require("request-promise-native");

const { getBridgeVersion } = require("matrix-appservice-bridge");

const DEBUG_PORT = 15555;
let asToken;

describe("Debug API", () => {
    const {env, roomMapping, test} = envBundle();
    asToken = env.config._registration.as_token;
    env.config.ircService.debugApi.enabled = true;
    env.config.ircService.debugApi.port = DEBUG_PORT;
    beforeEach(async () => {
        await test.beforeEach(env);
        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );
        await test.initEnv(env);
    });

    afterEach(async () => test.afterEach(env));

    it("should enable the debug API", async () => {
        // Revert to the default value for this one test
        expect(env.ircBridge.debugApi).not.toBeNull();
        const res = await request(`http://localhost:${DEBUG_PORT}/version?access_token=${asToken}`);
        expect(res).toEqual(getBridgeVersion());
    });
});
