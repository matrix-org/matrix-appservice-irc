import { TestIrcServer } from "matrix-org-irc";
import { IrcBridgeE2ETest } from "../util/e2e-test";
import { describe, it, expect } from "@jest/globals";
import { delay } from "../../src/promiseutil";

function createUserSet(count: number) {
    const localparts: string[] = [];
    for (let index = 0; index < count; index++) {
        localparts.push(TestIrcServer.generateUniqueNick(`alice-c${index}`));
    }
    return localparts;
}

describe('Bridge scaling test', () => {
    let testEnv: IrcBridgeE2ETest;
    beforeEach(async () => {
        testEnv = await IrcBridgeE2ETest.createTestEnv({
            matrixLocalparts: [TestIrcServer.generateUniqueNick("alice")],
            matrixSynclessLocalparts: createUserSet(80),
            ircNicks: ['bob'],
            traceToFile: true,
        });
        await testEnv.setUp();
    });
    afterEach(() => {
        return testEnv?.tearDown();
    });
    it('should be able to connect many users to a single channel', async () => {
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
        const aliceMsg = bob.waitForEvent('message', 10000);
        const bobMsg = alice.waitForRoomEvent(
            {eventType: 'm.room.message', sender: bobUserId, roomId: cRoomId}
        );
        alice.sendText(cRoomId, "Hello bob!");
        await aliceMsg;
        bob.say(channel, "Hi alice!");
        await bobMsg;

        // Track all the joins that we see.
        const ircJoins: {channel: string, nick: string}[] = [];
        bob.on('join', (joinChannel, nick) => ircJoins.push({channel: joinChannel, nick}));

        // Have all the Matrix users join
        const usersToJoin = homeserver.users.filter(u => testEnv.opts.matrixSynclessLocalparts?.includes(u.localpart))
        for (const mxUser of usersToJoin) {
            await mxUser.client.joinRoom(cRoomId);
        }

        // We now need to wait for all the expected joins on the IRC side.
        while (ircJoins.length < usersToJoin.length) {
            await delay(2000);
        }

        // Now check that all the users joined.
        for (const mxUser of usersToJoin) {
            expect(ircJoins).toContainEqual({ channel, nick: `M-${mxUser.localpart}`});
        }
    }, 100_000);
});
