"use strict";
var proxyquire =  require('proxyquire');
var clientMock = require("../util/client-sdk-mock");
clientMock["@global"] = true; // integration testing
var ircMock = require("../util/irc-mock");
ircMock["@global"] = true; // integration testing

var ircService = proxyquire("../../lib/irc-appservice.js", {
    "matirx-js-sdk": clientMock,
    "irc": ircMock
});
var ircConfig = {
    databaseUri: "mongodb://localhost:27017/matrix-appservice-irc-integration",
    servers: {
        "irc.example": {
            nick: "a_nick",
            expose: {
                channels: true,
                privateMessages: true
            },
            rooms: {
                mappings: {
                    "#coffee": ["!foo:bar"]
                }
            }
        }
    }
};
var serviceConfig = {
    hs: "https://some.home.server.goeshere",
    hsDomain: "some.home.server",
    token: "it's a secret",
    as: "https://mywuvelyapplicationservicerunninganircbridgeyay.gome",
    port: 2
};
var mockAsapiController = {
    setUserQueryResolver: function(fn) {},
    setAliasQueryResolver: function(fn) {},
    addRegexPattern: function(type, regex, exclusive){},
    setHomeserverToken: function(token) {},
    on: function(eventType, fn){}
};


describe("Initialisation", function() {
    // rip this from the config
    var ircAddr = Object.keys(ircConfig.servers)[0];
    var ircNick = ircConfig.servers[Object.keys(ircConfig.servers)[0]].nick;
    var ircChannel = Object.keys(
        ircConfig.servers[Object.keys(ircConfig.servers)[0]].rooms.mappings
    )[0];

    beforeEach(function() {
        
    });

    it("should connect to the IRC network and channel in the config", 
    function(done) {
        ircService.configure(ircConfig);
        ircService.register(mockAsapiController, serviceConfig).done(function() {
            var ircClient = ircMock._find(ircAddr, ircNick);
            expect(ircClient).toBeDefined();
            expect(ircClient.connect).toHaveBeenCalled();
            // invoke the connect callback
            ircClient.connect.calls[0].args[0]();
            // check it joins the right channel
            expect(ircClient.join).toHaveBeenCalled();
            expect(ircClient.join.calls[0].args[0]).toEqual(ircChannel);
            done();
        });

        
    });
});