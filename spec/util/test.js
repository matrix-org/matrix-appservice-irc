// common tasks performed in tests
"use strict";
var extend = require("extend");
var proxyquire =  require('proxyquire');

module.exports.mkEnv = function() {
    var clientMock = require("./client-sdk-mock");
    clientMock["@global"] = true; 
    var ircMock = require("./irc-client-mock");
    ircMock["@global"] = true;
    var dbHelper = require("./db-helper");
    var asapiMock = require("./asapi-controller-mock");
    var appConfig = extend(true, {}, require("../util/config-mock"));
    return {
        appConfig: appConfig,
        asapiMock: asapiMock,
        dbHelper: dbHelper,
        ircMock: ircMock,
        clientMock: clientMock,
        mockAsapiController: null
    };
};

module.exports.initEnv = function(env) {
    // wipe the database entirely then call configure and register on the IRC
    // service.
    return env.dbHelper._reset(env.appConfig.databaseUri).then(function() {
        env.ircService.configure(env.appConfig.ircConfig);
        return env.ircService.register(
            env.mockAsapiController, env.appConfig.serviceConfig
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

module.exports.log = function(testCase) {
    var desc = testCase.suite.description + " : " + testCase.description;
    console.log(desc);
    console.log(Array(1+desc.length).join("="));
};

module.exports.beforeEach = function(testCase, env) {
    module.exports.log(testCase);
    if (env) {
        env.ircMock._reset();
        env.clientMock._reset();
        env.ircService = proxyquire("../../lib/irc-appservice.js", {
            "matrix-js-sdk": env.clientMock,
            "irc": env.ircMock
        });
        env.mockAsapiController = env.asapiMock.create();
    }
};

