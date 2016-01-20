/*
 * Contains integration tests for IRC mode events.
 */
"use strict";
var Promise = require("bluebird");
var test = require("../util/test");

// set up integration testing mocks
var env = test.mkEnv();

// set up test config
var appConfig = env.appConfig;
var roomMapping = appConfig.roomMapping;

describe("IRC-to-Matrix mode bridging", function() {
    var sdk = null;

    var tFromNick = "mike";
    var tUserId = "@" + roomMapping.server + "_" + tFromNick + ":" +
                  appConfig.homeServerDomain;

    var configJoinRule = appConfig.ircConfig.servers[
            roomMapping.server
        ].dynamicChannels.joinRule;

    beforeEach(function(done) {
        test.beforeEach(this, env);

        sdk = env.clientMock._client();
        // add registration mock impl:
        // registering should be for the irc user
        sdk._onHttpRegister({
            expectLocalpart: roomMapping.server + "_" + tFromNick,
            returnUserId: tUserId
        });

        env.ircMock._autoJoinChannels(
            roomMapping.server, roomMapping.botNick, roomMapping.channel
        );
        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.channel
        );

        // do the init
        test.initEnv(env).done(function() {
            done();
        });
    });

    it("should set join_rules to 'invite' on +k.",
    function(done) {
        sdk.sendStateEvent.andCallFake(function(roomId, type, content, key) {
            expect(roomId).toEqual(roomMapping.roomId);
            expect(type).toEqual("m.room.join_rules");
            expect(content).toEqual({
                join_rule: "invite"
            });
            expect(key).toEqual("");
            done();
            return Promise.resolve();
        });

        env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(
        function(client) {
            client.emit("+mode", roomMapping.channel, "anIrcUser", "k");
        });
    });

    it("should set join_rules to 'invite' on +i.",
    function(done) {
        sdk.sendStateEvent.andCallFake(function(roomId, type, content, key) {
            expect(roomId).toEqual(roomMapping.roomId);
            expect(type).toEqual("m.room.join_rules");
            expect(content).toEqual({
                join_rule: "invite"
            });
            expect(key).toEqual("");
            done();
            return Promise.resolve();
        });

        env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(
        function(client) {
            client.emit("+mode", roomMapping.channel, "anIrcUser", "i");
        });
    });

    it("should revert join_rules to config value on -i.",
    function(done) {
        sdk.sendStateEvent.andCallFake(function(roomId, type, content, key) {
            expect(roomId).toEqual(roomMapping.roomId);
            expect(type).toEqual("m.room.join_rules");
            expect(content).toEqual({
                join_rule: configJoinRule
            });
            expect(key).toEqual("");
            done();
            return Promise.resolve();
        });

        env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(
        function(client) {
            client.emit("-mode", roomMapping.channel, "anIrcUser", "i");
        });
    });

    it("should revert join_rules to config value on -k.",
    function(done) {
        sdk.sendStateEvent.andCallFake(function(roomId, type, content, key) {
            expect(roomId).toEqual(roomMapping.roomId);
            expect(type).toEqual("m.room.join_rules");
            expect(content).toEqual({
                join_rule: configJoinRule
            });
            expect(key).toEqual("");
            done();
            return Promise.resolve();
        });

        env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).done(
        function(client) {
            client.emit("-mode", roomMapping.channel, "anIrcUser", "k");
        });
    });
});
