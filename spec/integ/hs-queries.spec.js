"use strict";
var test = require("../util/test");
var Promise = require("bluebird");

// set up integration testing mocks
var env = test.mkEnv();

// set up test config
var config = env.config;
var roomMapping = {
    server: config._server,
    botNick: config._botnick
};

describe("Homeserver user queries", function() {
    var testNick = "Alisha";
    var testLocalpart = roomMapping.server + "_" + testNick;
    var testUserId = (
        "@" + testLocalpart + ":" + config.homeserver.domain
    );

    beforeEach(test.coroutine(function*() {
        yield test.beforeEach(this, env); // eslint-disable-line no-invalid-this

        // accept connection requests
        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );

        // do the init
        yield test.initEnv(env);
    }));

    afterEach(test.coroutine(function*() {
        yield test.afterEach(this, env); // eslint-disable-line no-invalid-this
    }));

    it("should always create a new Matrix user for the specified ID",
    function(done) {
        var sdk = env.clientMock._client(config._botUserId);

        var askedWhois = false; // eslint-disable-line no-unused-vars
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

        env.mockAppService._queryUser(testUserId).done(function(res) {
            done();
        });
    });
});

describe("Homeserver alias queries", function() {
    var testChannel = "#tower";
    var testLocalpart = "irc_" + roomMapping.server + "_" + testChannel;
    var testAlias = (
        "#" + testLocalpart + ":" + config.homeserver.domain
    );

    beforeEach(test.coroutine(function*() {
        yield test.beforeEach(this, env); // eslint-disable-line no-invalid-this

        // accept connection requests
        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );

        // do the init
        try {
            yield test.initEnv(env);
        }
        catch (err) {
            console.error(err);
            expect(false).toBe(true, "onUserQuery failed request.");
        }
    }));

    afterEach(test.coroutine(function*() {
        yield test.afterEach(this, env); // eslint-disable-line no-invalid-this
    }));

    it("should make the AS start tracking the channel specified in the alias.",
    function(done) {
        var sdk = env.clientMock._client(config._botUserId);
        sdk.createRoom.andCallFake(function(opts) {
            expect(opts.room_alias_name).toEqual(testLocalpart);
            expect(opts.visibility).toEqual("public");
            return Promise.resolve({
                room_id: "!something:somewhere"
            });
        });

        sdk.sendStateEvent.andCallFake(function(roomId, eventType, obj) {
            expect(eventType).toEqual("m.room.history_visibility");
            expect(obj).toEqual({history_visibility: "joined"});
            return Promise.resolve({});
        });

        var botJoined = false;
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "join",
        function(client, channel, cb) {
            if (channel === testChannel) {
                botJoined = true;
                client._invokeCallback(cb);
            }
        });

        env.mockAppService._queryAlias(testAlias).done(function() {
            expect(botJoined).toBe(true, "Bot didn't join " + testChannel);
            done();
        }, function(err) {
            console.error(err);
            expect(false).toBe(true, "onAliasQuery failed request.");
            done();
        });
    });
});
