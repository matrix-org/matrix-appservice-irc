/*
 * Contains integration tests for IRC mode events.
 */
const envBundle = require("../util/env-bundle");


describe("IRC-to-Matrix mode bridging", () => {

    const {env, config, roomMapping, test} = envBundle();

    let sdk = null;

    const tFromNick = "mike";
    const tUserId = `@${roomMapping.server}_${tFromNick}:${config.homeserver.domain}`;

    const configJoinRule = config.ircService.servers[
        roomMapping.server
    ].dynamicChannels.joinRule;

    beforeEach(async () => {
        await test.beforeEach(env);
        const intent = env.clientMock._intent(config._botUserId);
        sdk = intent.underlyingClient;
        // add registration mock impl:
        // registering should be for the irc user
        intent._onHttpRegister({
            expectLocalpart: roomMapping.server + "_" + tFromNick,
            returnUserId: tUserId
        });

        env.ircMock._autoJoinChannels(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );
        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );

        await test.initEnv(env);
    });

    afterEach(async () => test.afterEach(env));

    it("should set join_rules to 'invite' on +k.", async (done) => {
        sdk.sendStateEvent.and.callFake((roomId, type, key, content) => {
            expect(roomId).toEqual(roomMapping.roomId);
            expect(type).toEqual("m.room.join_rules");
            expect(content).toEqual({
                join_rule: "invite"
            });
            expect(key).toEqual("");
            done();
        });

        const client = await env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick);
        client.emit("+mode", roomMapping.channel, "anIrcUser", "k");
    });

    it("should set join_rules to 'invite' on +i.", async (done) => {
        sdk.sendStateEvent.and.callFake((roomId, type, key, content) => {
            expect(roomId).toEqual(roomMapping.roomId);
            expect(type).toEqual("m.room.join_rules");
            expect(content).toEqual({
                join_rule: "invite"
            });
            expect(key).toEqual("");
            done();
        });

        const client = await env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick);
        client.emit("+mode", roomMapping.channel, "anIrcUser", "i");
    });

    it("should revert join_rules to config value on -i.", async (done) => {
        sdk.sendStateEvent.and.callFake((roomId, type, key, content) => {
            expect(roomId).toEqual(roomMapping.roomId);
            expect(type).toEqual("m.room.join_rules");
            expect(content).toEqual({
                join_rule: configJoinRule
            });
            expect(key).toEqual("");
            done();
        });

        const client = await env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick);
        client.emit("-mode", roomMapping.channel, "anIrcUser", "i");
    });

    it("should revert join_rules to config value on -k.", async (done) => {
        sdk.sendStateEvent.and.callFake((roomId, type, key, content) => {
            expect(roomId).toEqual(roomMapping.roomId);
            expect(type).toEqual("m.room.join_rules");
            expect(content).toEqual({
                join_rule: configJoinRule
            });
            expect(key).toEqual("");
            done();
        });

        const client = await env.ircMock._findClientAsync(roomMapping.server, roomMapping.botNick);
        client.emit("-mode", roomMapping.channel, "anIrcUser", "k");
    });
});
