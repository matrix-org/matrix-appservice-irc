/*
 * Contains integration tests for all Startup-initiated events.
 */

const envBundle = require("../util/env-bundle");

describe("Initialisation", () => {
    const {env, roomMapping, test} = envBundle();
    const ircAddr = roomMapping.server;
    const ircNick = roomMapping.botNick;
    const ircChannel = roomMapping.channel;

    beforeEach(async () => {
        await test.beforeEach(env);
    });

    afterEach(async () => test.afterEach(env));

    it("should connect to the IRC network and channel in the config", (done) => {
        let clientConnected = false;
        let clientJoined = false;

        env.ircMock._whenClient(ircAddr, ircNick, "connect", (client, fn) => {
            expect(clientJoined).toBe(false, "Joined before connect call");
            clientConnected = true;
            fn();
        });


        env.ircMock._whenClient(ircAddr, ircNick, "join", (client, chan, fn) => {
            expect(chan).toEqual(ircChannel);
            expect(clientConnected).toBe(true, "Didn't connect before join call");
            clientJoined = true;
            done();
        });

        // run the test
        test.initEnv(env);
    });

    it("[BOTS-70] should attempt to set the bot nick if ircd assigned random string", (done) => {
        const assignedNick = "5EXABJ6GG";

        // let the bot connect
        env.ircMock._whenClient(roomMapping.server, ircNick, "connect", (client, cb) => {
            // after the connect callback, modify their nick and emit an event.
            client._invokeCallback(cb).then(function() {
                process.nextTick(function() {
                    client.nick = assignedNick;
                    client.emit("nick", ircNick, assignedNick);
                    done();
                });
            });
        });

        env.ircMock._whenClient(roomMapping.server, ircNick, "send", (client, command, arg) => {
            expect(client.nick).toEqual(ircNick, "use the old nick on /nick");
            expect(client.addr).toEqual(roomMapping.server);
            expect(command).toEqual("NICK");
            expect(arg).toEqual(ircNick);
            done();
        });

        // run the test
        test.initEnv(env);
    });
});
