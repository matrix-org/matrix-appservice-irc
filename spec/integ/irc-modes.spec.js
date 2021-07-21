/*
 * Contains integration tests for IRC mode events.
 */
const Promise = require("bluebird");

const envBundle = require("../util/env-bundle");


describe("IRC-to-Matrix mode bridging", function() {

    const {env, config, roomMapping, test} = envBundle();

    let sdk = null;

    const tFromNick = "mike";
    const tUserId = "@" + roomMapping.server + "_" + tFromNick + ":" +
                  config.homeserver.domain;

    const configJoinRule = config.ircService.servers[
        roomMapping.server
    ].dynamicChannels.joinRule;

    beforeEach(test.coroutine(function*() {
        yield test.beforeEach(env);

        sdk = env.clientMock._client(config._botUserId);
        // add registration mock impl:
        // registering should be for the irc user
        sdk._onHttpRegister({
            expectLocalpart: roomMapping.server + "_" + tFromNick,
            returnUserId: tUserId
        });

        env.ircMock._autoJoinChannels(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );
        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );

        // do the init
        yield test.initEnv(env);
    }));

    afterEach(test.coroutine(function*() {
        yield test.afterEach(env);
    }));

    it("should set join_rules to 'invite' on +k.", (done) => {
        sdk.sendStateEvent.and.callFake(function(roomId, type, content, key) {
            expect(roomId).toEqual(roomMapping.roomId);
            expect(type).toEqual("m.room.join_rules");
            expect(content).toEqual({
                join_rule: "invite"
            });
            expect(key).toEqual("");
            done();
            return Promise.resolve();
        });

        env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).then((client) => {
            client.emit("+mode", roomMapping.channel, "anIrcUser", "k");
        });
    });

    it("should set join_rules to 'invite' on +i.", (done) => {
        sdk.sendStateEvent.and.callFake(function(roomId, type, content, key) {
            expect(roomId).toEqual(roomMapping.roomId);
            expect(type).toEqual("m.room.join_rules");
            expect(content).toEqual({
                join_rule: "invite"
            });
            expect(key).toEqual("");
            done();
            return Promise.resolve();
        });

        env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).then((client) => {
            client.emit("+mode", roomMapping.channel, "anIrcUser", "i");
        });
    });

    it("should revert join_rules to config value on -i.", (done) => {
        sdk.sendStateEvent.and.callFake(function(roomId, type, content, key) {
            expect(roomId).toEqual(roomMapping.roomId);
            expect(type).toEqual("m.room.join_rules");
            expect(content).toEqual({
                join_rule: configJoinRule
            });
            expect(key).toEqual("");
            done();
            return Promise.resolve();
        });

        env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).then((client) => {
            client.emit("-mode", roomMapping.channel, "anIrcUser", "i");
        });
    });

    it("should revert join_rules to config value on -k.", (done) => {
        sdk.sendStateEvent.and.callFake(function(roomId, type, content, key) {
            expect(roomId).toEqual(roomMapping.roomId);
            expect(type).toEqual("m.room.join_rules");
            expect(content).toEqual({
                join_rule: configJoinRule
            });
            expect(key).toEqual("");
            done();
            return Promise.resolve();
        });

        env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick).then((client) => {
            client.emit("-mode", roomMapping.channel, "anIrcUser", "k");
        });
    });
});
