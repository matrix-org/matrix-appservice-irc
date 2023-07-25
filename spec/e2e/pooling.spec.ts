import { TestIrcServer } from "matrix-org-irc";
import { IrcBridgeE2ETest } from "../util/e2e-test";
import { describe, it } from "@jest/globals";

const describeif = IrcBridgeE2ETest.usingRedis ? describe : describe.skip;

describeif('Connection pooling', () => {
    let testEnv: IrcBridgeE2ETest;

    beforeEach(async () => {
        // Initial run of the bridge to setup a testing environment
        testEnv = await IrcBridgeE2ETest.createTestEnv({
            matrixLocalparts: [TestIrcServer.generateUniqueNick('alice')],
            ircNicks: ['bob'],
            config: {
                connectionPool: {
                    redisUrl: 'unused',
                    persistConnectionsOnShutdown: true,
                }
            }
        });
        await testEnv.setUp();
    });

    // Ensure we always tear down
    afterEach(() => {
        return testEnv.tearDown();
    });

    it('should be able to shut down the bridge and start back up again', async () => {
        const channel = `#${TestIrcServer.generateUniqueNick("test")}`;

        const { homeserver } = testEnv;
        const alice = homeserver.users[0].client;
        const { bob } = testEnv.ircTest.clients;

        // Create the channel
        await bob.join(channel);

        const adminRoomId = await testEnv.createAdminRoomHelper(alice);
        const cRoomId = await testEnv.joinChannelHelper(alice, adminRoomId, channel);

        // And finally wait for bob to appear.
        const bobUserId = `@irc_${bob.nick}:${homeserver.domain}`;
        await alice.waitForRoomEvent(
            {eventType: 'm.room.member', sender: bobUserId, stateKey: bobUserId, roomId: cRoomId}
        );


        // Send some messages
        let aliceMsg = bob.waitForEvent('message', 10000);
        let bobMsg = alice.waitForRoomEvent(
            {eventType: 'm.room.message', sender: bobUserId, roomId: cRoomId}
        );
        alice.sendText(cRoomId, "Hello bob!");
        await aliceMsg;
        bob.say(channel, "Hi alice!");
        await bobMsg;

        console.log('Recreating bridge');

        // Now kill the bridge, do NOT kill the dependencies.
        await testEnv.recreateBridge();
        await testEnv.setUp();

        aliceMsg = bob.waitForEvent('message', 10000);
        bobMsg = alice.waitForRoomEvent(
            {eventType: 'm.room.message', sender: bobUserId, roomId: cRoomId}
        );
        alice.sendText(cRoomId, "Hello bob!");
        await aliceMsg;
        bob.say(channel, "Hi alice!");
        await bobMsg;
    });
});
