/*
 * Contains integration tests for all Startup-initiated events.
 */
"use strict";
// set up integration testing mocks
var proxyquire =  require('proxyquire');
var clientMock = require("../util/client-sdk-mock");
clientMock["@global"] = true; 
var ircMock = require("../util/irc-client-mock");
ircMock["@global"] = true;
var dbHelper = require("../util/db-helper");
var asapiMock = require("../util/asapi-controller-mock");

// set up test config
var appConfig = require("../util/config-mock");
var ircConfig = appConfig.ircConfig;
var roomMapping = appConfig.roomMapping;

describe("Initialisation", function() {
    var ircService = null;
    var ircAddr = roomMapping.server;
    var ircNick = roomMapping.botNick;
    var ircChannel = roomMapping.channel;
    var databaseUri = ircConfig.databaseUri;

    var mockAsapiController = null;

    beforeEach(function(done) {
        console.log(" === Initialisation Test Start === ");
        ircMock._reset();
        clientMock._reset();
        dbHelper._reset(databaseUri).done(function() {
            done();
        });
        mockAsapiController = asapiMock.create();
        ircService = proxyquire("../../lib/irc-appservice.js", {
            "matrix-js-sdk": clientMock,
            "irc": ircMock
        });
    });

    it("should connect to the IRC network and channel in the config", 
    function(done) {
        var clientConnected = false;
        ircMock._whenClient(ircAddr, ircNick, "connect", function(client, fn) {
            expect(clientJoined).toBe(false, "Joined before connect call");
            clientConnected = true;
            fn();
        });

        var clientJoined = false;
        ircMock._whenClient(ircAddr, ircNick, "join", function(client, chan, fn) {
            expect(chan).toEqual(ircChannel);
            expect(clientConnected).toBe(true, "Connected before join call");
            clientJoined = true;
            done();
        });

        // run the test
        ircService.configure(ircConfig);
        ircService.register(mockAsapiController, appConfig.serviceConfig);
    });
});