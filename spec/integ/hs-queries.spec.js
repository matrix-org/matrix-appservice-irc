
const Promise = require("bluebird");
const envBundle = require("../util/env-bundle");

describe("Homeserver user queries", function() {
    const {env, config, roomMapping, test} = envBundle();

    let testNick = "Alisha";
    let testLocalpart = roomMapping.server + "_" + testNick;
    let testUserId = (
        "@" + testLocalpart + ":" + config.homeserver.domain
    );


    beforeEach(test.coroutine(function*() {
        yield test.beforeEach(env);

        // accept connection requests
        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );

        // do the init
        yield test.initEnv(env);
    }));

    afterEach(test.coroutine(function*() {
        yield test.afterEach(env);
    }));

    it("should always create a new Matrix user for the specified ID", (done) => {
        let sdk = env.clientMock._client(config._botUserId);

        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "whois", (client, nick, cb) => {
            expect(nick).toEqual(testNick);
            // say they exist (presence of user key)
            cb({
                user: testNick,
                nick: testNick
            });
        });

        sdk._onHttpRegister({
            expectLocalpart: testLocalpart,
            returnUserId: testUserId
        });

        env.mockAppService._queryUser(testUserId).then(done);
    });
});

describe("Homeserver alias queries", function() {
    const {env, config, roomMapping, test} = envBundle();
    const testChannel = "#tower";
    const testLocalpart = "irc_" + roomMapping.server + "_" + testChannel;
    const testAlias = (
        "#" + testLocalpart + ":" + config.homeserver.domain
    );

    beforeEach(test.coroutine(function*() {
        yield test.beforeEach(env);

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
        yield test.afterEach(env);
    }));

    it("should make the AS start tracking the channel specified in the alias.", (done) => {
        const sdk = env.clientMock._client(config._botUserId);
        sdk.createRoom.and.callFake(function(opts) {
            expect(opts.room_alias_name).toEqual(testLocalpart);
            expect(opts.visibility).toEqual("private");
            return Promise.resolve({
                room_id: "!something:somewhere"
            });
        });

        sdk.sendStateEvent.and.callFake(function(roomId, eventType, obj) {
            expect(eventType).toEqual("m.room.history_visibility");
            expect(obj).toEqual({history_visibility: "joined"});
            return Promise.resolve({});
        });

        let botJoined = false;
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "join", (client, channel, cb) => {
            if (channel === testChannel) {
                botJoined = true;
                client._invokeCallback(cb);
            }
        });

        env.mockAppService._queryAlias(testAlias).then(function() {
            expect(botJoined).toBe(true, "Bot didn't join " + testChannel);
            done();
        }, function(err) {
            console.error(err);
            expect(false).toBe(true, "onAliasQuery failed request.");
            done();
        });
    });
});
