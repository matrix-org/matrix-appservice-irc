/*
 * Contains integration tests for all Startup-initiated events.
 */
"use strict";
// set up integration testing mocks
var proxyquire =  require('proxyquire');
var clientMock = require("../util/client-sdk-mock");
clientMock["@global"] = true; 
var ircMock = require("../util/irc-mock");
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
        // do the init
        ircService.configure(ircConfig);
        ircService.register(mockAsapiController, ircConfig).then(function() {
            var ircClient = ircMock._findClient(ircAddr, ircNick);
            expect(ircClient).toBeDefined();
            expect(ircClient.connect).toHaveBeenCalled();
            expect(ircClient.join).not.toHaveBeenCalled();
            // invoke the connect callback
            return ircClient._triggerConnect();
        }).then(function(client) {
            // check it joins the right channel
            expect(client.join).toHaveBeenCalled();
            expect(client.join.calls[0].args[0]).toEqual(ircChannel);
            done();
        }).done();
    });
});