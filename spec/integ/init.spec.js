/*
 * Contains integration tests for all Startup-initiated events.
 */
"use strict";
var test = require("../util/test");

// set up integration testing mocks
var env = test.mkEnv();

// set up test config
var appConfig = env.appConfig;
var ircConfig = appConfig.ircConfig;
var roomMapping = appConfig.roomMapping;

describe("Initialisation", function() {
    var ircAddr = roomMapping.server;
    var ircNick = roomMapping.botNick;
    var ircChannel = roomMapping.channel;
    var databaseUri = ircConfig.databaseUri;

    beforeEach(function(done) {
        test.beforeEach(this, env);
        env.dbHelper._reset(databaseUri).done(function() {
            done();
        });
    });

    it("should connect to the IRC network and channel in the config",
    function(done) {
        var clientConnected = false;
        env.ircMock._whenClient(ircAddr, ircNick, "connect",
        function(client, fn) {
            expect(clientJoined).toBe(false, "Joined before connect call");
            clientConnected = true;
            fn();
        });

        var clientJoined = false;
        env.ircMock._whenClient(ircAddr, ircNick, "join",
        function(client, chan, fn) {
            expect(chan).toEqual(ircChannel);
            expect(clientConnected).toBe(true, "Connected before join call");
            clientJoined = true;
            done();
        });

        // run the test
        env.ircService.configure(ircConfig);
        env.ircService.register(
            env.mockAsapiController, appConfig.serviceConfig
        );
    });
});
