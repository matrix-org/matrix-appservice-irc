const envBundle = require("../util/env-bundle");
const request = require("request-promise-native");

const { getBridgeVersion } = require("../../lib/util/PackageInfo");

const DEBUG_PORT = 15555;
let asToken;

describe("Debug API", function() {
    const {env, roomMapping, test} = envBundle();
    asToken = env.config._registration.as_token;
    env.config.ircService.debugApi.enabled = true;
    env.config.ircService.debugApi.port = DEBUG_PORT;
    beforeEach(test.coroutine(function*() {
        yield test.beforeEach(env);

        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );

        yield test.initEnv(env);
    }));

    afterEach(test.coroutine(function*() {
        yield test.afterEach(env);
    }));

    it("should enable the debug API", async () => {
        // Revert to the default value for this one test
        expect(env.ircBridge.debugApi).not.toBeNull();
        const res = await request(`http://localhost:${DEBUG_PORT}/version?access_token=${asToken}`);
        expect(res).toEqual(getBridgeVersion());
    });
});
