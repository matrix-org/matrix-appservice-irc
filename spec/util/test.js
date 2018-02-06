// common tasks performed in tests
"use strict";
var extend = require("extend");
var proxyquire = require('proxyquire');
var AppServiceRegistration = require("matrix-appservice-bridge").AppServiceRegistration;
var MockAppService = require("./app-service-mock");
var Promise = require("bluebird");

// Log the test case. Jasmine is a global var.
jasmine.getEnv().addReporter({
    specStarted: function(result) {
        console.log(result.fullName);
        console.log(new Array(2 + result.fullName.length).join("="));
    }
});

/**
 * Construct a new test environment with mock modules.
 * @return {Object} containing a set of mock modules.
 */
module.exports.mkEnv = function() {
    var clientMock = require("./client-sdk-mock");
    clientMock["@global"] = true;
    var ircMock = require("./irc-client-mock");
    ircMock["@global"] = true;
    var config = extend(true, {}, require("../util/test-config.json"));
    return {
        config: config,
        ircMock: ircMock,
        clientMock: clientMock,
        mockAppService: null // reset each test
    };
};

/**
 * Initialise a new test environment. This will clear the test database and
 * register the IRC service (as if it were called by app.js).
 * @param {Object} env : The test environment to initialise with
 * (from {@link mkEnv}).
 * @return {Promise} which is resolved when the app has finished initiliasing.
 */
module.exports.initEnv = function(env, customConfig) {
    return env.main.runBridge(
        env.config._port, customConfig || env.config,
        AppServiceRegistration.fromObject(env.config._registration), true
    ).catch(function(e) {
        var msg = JSON.stringify(e);
        if (e.stack) {
            msg = e.stack;
        }
        console.error("FATAL");
        console.error(msg);
    });
};

/**
 * Reset the test environment for a new test case that has just run.
 * This kills the bridge.
 * @param {Object} env : The test environment.
 */
module.exports.afterEach = Promise.coroutine(function*(env) {
    // If there was a previous bridge running, kill it
    // This is prevent IRC clients spamming the logs
    if (env.main) {
        yield env.main.killBridge();
    }
});

/**
 * Reset the test environment for a new test case. This resets all mocks.
 * @param {Object} env : The pre-initialised test environment.
 */
module.exports.beforeEach = Promise.coroutine(function*(env) {
    MockAppService.resetInstance();
    if (env) {
        env.ircMock._reset();
        env.clientMock._reset();

        env.main = proxyquire("../../lib/main.js", {
            "matrix-appservice": {
                AppService: MockAppService,
                "@global": true
            },
            "matrix-js-sdk": env.clientMock,
            "irc": env.ircMock
        });
        env.mockAppService = MockAppService.instance();
    }

    process.on("unhandledRejection", function(reason, promise) {
        if (reason.stack) {
            throw reason;
        }
        throw new Error("Unhandled rejection: " + reason);
    });
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
