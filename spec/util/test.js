// common tasks performed in tests
const extend = require("extend");
const proxyquire = require('proxyquire');
const AppServiceRegistration = require("matrix-appservice-bridge").AppServiceRegistration;
const MockAppService = require("./app-service-mock");
const Promise = require("bluebird");
const clientMock = require("./client-sdk-mock");
const ircMock = require("./irc-client-mock");
const { Client } = require('pg');

clientMock["@global"] = true;
ircMock["@global"] = true;
const main = proxyquire("../../lib/main.js", {
    "matrix-appservice": {
        AppService: MockAppService,
        "@global": true
    },
    "matrix-js-sdk": clientMock,
    "irc": ircMock,
});

// Log the test case. Jasmine is a global var.
jasmine.getEnv().addReporter({
    specStarted: function(result) {
        console.log(result.fullName);
        console.log(new Array(2 + result.fullName.length).join("="));
    }
});

class TestEnv {
    constructor(config, mockAppService) {
        this.config = config;
        this.mockAppService = mockAppService;
        this.main = main;
        this.ircBridge = null;
        this.ircMock = ircMock;
        this.clientMock = clientMock;
        this.usingPg = process.env.IRCBRIDGE_TEST_ENABLEPG === "yes";
        // Inject postgres
        if (!this.usingPg) {
            return;
        }

        this.config.database = {
            engine: "postgres",
            connectionString: `${process.env.IRCBRIDGE_TEST_PGURL}/${process.env.IRCBRIDGE_TEST_PGDB}`,
        };
    }

    /**
     * Initialise a new test environment. This will clear the test database and
     * register the IRC service (as if it were called by app.js).
     * @return {Promise} which is resolved when the app has finished initiliasing.
     */
    async init(customConfig) {
        console.log("FOOO");
        let ircBridge;
        try {
            if (this.usingPg) {
                console.log("FOOO1");
                const db = process.env.IRCBRIDGE_TEST_PGDB;
                const superClient = new Client(`${process.env.IRCBRIDGE_TEST_PGURL}/postgres`);
                console.log("FOOO2");
                await superClient.connect();
                console.log("FOOO3");
                await superClient.query(`DROP DATABASE IF EXISTS ${db};`);
                await superClient.query(`CREATE DATABASE ${db};`);
                console.log("FOOO4");
                await superClient.end();
                console.log("FOOO5");
            }
            ircBridge = await this.main.runBridge(
                this.config._port, customConfig || this.config,
                AppServiceRegistration.fromObject(this.config._registration), true
            )
        }
        catch (ex) {
            const msg = JSON.stringify(e);
            if (e.stack) {
                msg = e.stack;
            }
            console.error("FATAL");
            console.error(msg);
            return;
        }
        console.log("Bridge created");
        this.ircBridge = ircBridge;
    }

    /**
     * Reset the test environment for a new test case that has just run.
     * This kills the bridge.
     **/
    afterEach() {
        if (!this.main) {
            return Promise.resolve();
        }
        // If there was a previous bridge running, kill it
        // This is prevent IRC clients spamming the logs
        return this.main.killBridge(this.ircBridge).then(() => {
            if (global.gc) {global.gc();}
        })
    }

    /**
     * Reset the test environment for a new test case. This resets all mocks.
     */
    async beforeEach() {
        ircMock._reset();
        clientMock._reset();
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


module.exports.initEnv = Promise.coroutine(function*(env, customConfig) {
    return yield env.init(customConfig);
});

module.exports.afterEach = function(env) {
    return env.afterEach();
};

/**
 * Reset the test environment for a new test case. This resets all mocks.
 * @param {Object} env : The pre-initialised test environment.
 */
module.exports.beforeEach = Promise.coroutine(function*(env) {
    MockAppService.resetInstance();
    if (env) {
        return yield env.beforeEach();
    }
    process.on("unhandledRejection", function(reason) {
        if (reason.stack) {
            throw reason;
        }
        throw new Error("Unhandled rejection: " + reason);
    });
    return Promise.resolve();
});

/**
 * Transform a given generator function into a coroutine and wrap it up in a Jasmine
 * async test function. This allows seamless use of async function(done) tests using
 * yield. For example:
 * <pre>
 *   it("should do stuff", test.coroutine(function*() {
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
