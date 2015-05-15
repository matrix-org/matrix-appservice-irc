"use strict";
var test = require("../util/test");
var q = require("q");

// set up integration testing mocks
var env = test.mkEnv();

// set up test config
var appConfig = env.appConfig;
var roomMapping = appConfig.roomMapping;

describe("Homeserver user queries", function() {
    var testNick = "Alisha";
    var testLocalpart = roomMapping.server + "_" + testNick;
    var testUserId = (
        "@" + testLocalpart + ":" + appConfig.homeServerDomain
    );

    beforeEach(function(done) {
        test.beforeEach(this, env);

        // accept connection requests
        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );

        // do the init
        test.initEnv(env).done(function() {
            done();
        });
    });

    it("should always create a new Matrix user for the specified ID",
    function(done) {
        var sdk = env.clientMock._client();

        var askedWhois = false;
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "whois",
        function(client, nick, cb) {
            expect(nick).toEqual(testNick);
            // say they exist (presence of user key)
            askedWhois = true;
            cb({
                user: testNick,
                nick: testNick
            });
        });

        sdk._onHttpRegister({
            expectLocalpart: testLocalpart,
            returnUserId: testUserId
        });

        env.mockAsapiController._queryUser(testUserId).done(function(res) {
            done();
        });
    });
});

describe("Homeserver alias queries", function() {
    var testChannel = "#tower";
    var testLocalpart = "irc_" + roomMapping.server + "_" + testChannel;
    var testAlias = (
        "#" + testLocalpart + ":" + appConfig.homeServerDomain
    );

    beforeEach(function(done) {
        test.beforeEach(this, env);

        // accept connection requests
        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );

        // do the init
        test.initEnv(env).done(function() {
            done();
        }, function(err) {
            console.error(err);
            expect(false).toBe(true, "onUserQuery failed request.");
            done();
        });
    });

    it("should make the AS start tracking the channel specified in the alias.",
    function(done) {
        var sdk = env.clientMock._client();
        sdk.createRoom.andCallFake(function(opts) {
            expect(opts.room_alias_name).toEqual(testLocalpart);
            expect(opts.visibility).toEqual("public");
            return q({
                room_id: "!something:somewhere"
            });
        });

        var botJoined = false;
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "join",
        function(client, channel, cb) {
            expect(channel).toEqual(testChannel);
            botJoined = true;
            client._invokeCallback(cb);
        });

        env.mockAsapiController._queryAlias(testAlias).done(function() {
            expect(botJoined).toBe(true);
            done();
        }, function(err) {
            console.error(err);
            expect(false).toBe(true, "onAliasQuery failed request.");
            done();
        });
    });
});
