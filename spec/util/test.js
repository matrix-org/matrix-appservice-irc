// common tasks performed in tests
const extend = require("extend");
const proxyquire = require('proxyquire');
const { AppServiceRegistration, Intent } = require("matrix-appservice-bridge");
const MockAppService = require("./app-service-mock");
const Promise = require("bluebird");
const clientMock = require("./bot-sdk-mock");
const ircMock = require("./irc-client-mock");
const { Client } = require('pg');

const USING_PG = process.env.IRCBRIDGE_TEST_ENABLEPG === "yes";

clientMock["@global"] = true;
ircMock["@global"] = true;
const main = proxyquire("../../lib/main.js", {
    "matrix-appservice": {
        AppService: MockAppService,
        "@global": true
    },
    "matrix-org-irc": ircMock,
});

// Log the test case. Jasmine is a global var.
jasmine.getEnv().addReporter({
    specStarted: function(result) {
        console.log(result.fullName);
        console.log("=".repeat(result.fullName.length + 1));
    }
});

let pgClient;
let pgClientConnectPromise;

if (USING_PG) {
    // Setup postgres for the whole process.
    pgClient = new Client(`${process.env.IRCBRIDGE_TEST_PGURL}/postgres`);
    pgClientConnectPromise = (async () => {
        await pgClient.connect();
    })();
    process.on("beforeExit", async () => {
        pgClient.end();
    })
}


class TestEnv {
    constructor(config, mockAppService) {
        this.config = config;
        this.mockAppService = mockAppService;
        this.main = main;
        this.ircBridge = null;
        this.ircMock = ircMock;
        this.clientMock = clientMock;
        this.botClient = null;
    }

    /**
     * Function to create a mock matrix-appservice-bridge Intent.
     *
     * @param {string} userId The userId to create.
     * @param {any} opts
     * @returns
     */
    intentCreateFn(userId, opts) {
        userId = userId || this.config._registration._botUserId;
        const botSdkIntent = clientMock._intent(userId);
        return new Intent(botSdkIntent, this.botClient, { ...opts });
    }

    /**
     * Initialise a new test environment. This will clear the test database and
     * register the IRC service (as if it were called by app.js).
     * @return {Promise} which is resolved when the app has finished initiliasing.
     */
    async init(customConfig) {
        let ircBridge;
        try {
            ircBridge = await this.main.runBridge(
                this.config._port, customConfig || this.config,
                AppServiceRegistration.fromObject(this.config._registration),
                {
                    isDBInMemory:  !USING_PG,
                    skipPingCheck: true,
                    onIntentCreate: (...args) => this.intentCreateFn(...args),
                }
            )
        }
        catch (e) {
            let msg = JSON.stringify(e);
            if (e.stack) {
                msg = e.stack;
            }
            console.error("FATAL");
            console.error(msg);
            return;
        }
        this.ircBridge = ircBridge;
    }

    /**
     * Reset the test environment for a new test case that has just run.
     * This kills the bridge.
     **/
    async afterEach() {
        if (!this.main) {
            return;
        }
        // If there was a previous bridge running, kill it
        // This prevents IRC clients spamming the logs
        await this.main.killBridge(this.ircBridge, "test teardown");
        if (global.gc) {
            global.gc();
        }
    }

    /**
     * Reset the test environment for a new test case. This resets all mocks.
     */
    async beforeEach() {
        ircMock._reset();
        clientMock._reset();
        const client = clientMock._client(this.config._botUserId);
        this.botClient = client;
        if (USING_PG) {
            await pgClientConnectPromise;
            // Create a new DB for each test
            this.pgDb = `${process.env.IRCBRIDGE_TEST_PGDB}_${process.hrtime().join("_")}`;
            this.config.database = {
                engine: "postgres",
                connectionString: `${process.env.IRCBRIDGE_TEST_PGURL}/${this.pgDb}`,
            };
            await pgClient.query(`CREATE DATABASE ${this.pgDb}`);
        }
        this.mockAppService = MockAppService.instance();
        return true;
    }
}

/**
 * Construct a new test environment with mock modules.
 * @return {Object} containing a set of mock modules.
 */
module.exports.mkEnv = function() {
    const config = extend(true, {}, require("../util/test-config.json"));
    return new TestEnv(
        config,
        null // reset each test
    );
};


module.exports.initEnv = (env, customConfig) => {
    return env.init(customConfig);
};

module.exports.afterEach = function(env) {
    return env.afterEach();
};

/**
 * Reset the test environment for a new test case. This resets all mocks.
 * @param {Object} env : The pre-initialised test environment.
 */
module.exports.beforeEach = async (env) => {
    MockAppService.resetInstance();
    if (env) {
        return env.beforeEach();
    }
    process.on("unhandledRejection", function(reason) {
        if (reason.stack) {
            throw reason;
        }
        throw new Error("Unhandled rejection: " + reason);
    });
    return null;
}

/**
 * Transform a given generator function into a coroutine and wrap it up in a Jasmine
 * async test function. This allows seamless use of async function(done) tests using
 * yield. For example:
 * <pre>
 *   it("should do stuff", async () => {
 *     var something = yield doThing();
 *   }));
 * </pre>
 * When the promise RESOLVES it will call done() on the Jasmine async test function.
 * When the promise REJECTS it will fail an assertion.
 * @param {Function} generatorFn The generator function to wrap e.g
 * @return {Function} A jasmine async test function.
 */
module.exports.coroutine = function(generatorFn) {
    return function(done) {
        var fn = Promise.coroutine(generatorFn);
        fn.apply(this).then(function() { // eslint-disable-line no-invalid-this
            done();
        }, function(err) {
            expect(true).toBe(false, "Coroutine threw: " + err + "\n" + err.stack);
            done();
        })
    };
};
