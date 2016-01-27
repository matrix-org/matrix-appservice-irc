// common tasks performed in tests
"use strict";
var extend = require("extend");
var proxyquire = require('proxyquire');
var AppServiceRegistration = require("matrix-appservice-bridge").AppServiceRegistration;
var MockAppService = require("./app-service-mock");

/**
 * Construct a new test environment with mock modules.
 * @return {Object} containing a set of mock modules.
 */
module.exports.mkEnv = function() {
    var clientMock = require("./client-sdk-mock");
    clientMock["@global"] = true;
    var ircMock = require("./irc-client-mock");
    ircMock["@global"] = true;
    var dbHelper = require("./db-helper");
    var config = extend(true, {}, require("../util/test-config.json"));
    return {
        config: config,
        dbHelper: dbHelper,
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
    // wipe the database entirely then call configure and register on the IRC
    // service.
    return env.dbHelper._reset(env.config.ircService.databaseUri).then(function() {
        return env.main.runBridge(
            env.config._port, customConfig || env.config,
            AppServiceRegistration.fromObject(env.config._registration)
        );
    }).catch(function(e) {
        var msg = JSON.stringify(e);
        if (e.stack) {
            msg = e.stack;
        }
        console.error("FATAL");
        console.error(msg);
    });
};

/**
 * Log a description of the current test case to the console.
 * @param {TestCase} testCase : The Jasmine test case to log.
 */
module.exports.log = function(testCase) {
    var desc = testCase.suite.description + " : " + testCase.description;
    console.log(desc);
    console.log(new Array(1 + desc.length).join("="));
};

/**
 * Reset the test environment for a new test case. This resets all mocks.
 * @param {TestCase} testCase : The new test case.
 * @param {Object} env : The pre-initialised test environment.
 */
module.exports.beforeEach = function(testCase, env) {
    module.exports.log(testCase);
    MockAppService.resetInstance();
    if (env) {
        env.ircMock._reset();
        env.clientMock._reset();
        env.main = proxyquire("../../lib/main.js", {
            "matrix-appservice": {
                AppService: MockAppService
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
};

