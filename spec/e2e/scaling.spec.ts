import { ChanData, TestIrcServer } from "matrix-org-irc";
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

        // Have all the Matrix users join
        const usersToJoin = homeserver.users.filter(u => testEnv.opts.matrixSynclessLocalparts?.includes(u.localpart))
        for (const mxUser of usersToJoin) {
            await mxUser.client.joinRoom(cRoomId);
        }

        // We now need to wait for all the expected joins on the IRC side.
        const chanData = bob.chanData(channel, false);
        if (!chanData) {
            throw Error('Expected to have channel data for channel');
        }

        do {
            await delay(500);
        } while (chanData?.users.size < homeserver.users.length)

        // Now check that all the users joined.
        for (const mxUser of usersToJoin) {
            expect(chanData.users.keys()).toContain(`M-${mxUser.localpart}`)
        }
    }, 100_000);

    it('should be able to sync many users on startup', async () => {
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

        // Have all the Matrix users join
        const usersToJoin = homeserver.users.filter(u => testEnv.opts.matrixSynclessLocalparts?.includes(u.localpart))
        for (const mxUser of usersToJoin) {
            await mxUser.client.joinRoom(cRoomId);
        }

        // Now kill the bridge
        await testEnv.recreateBridge();
        await testEnv.setUp();


        // We now need to wait for all the expected joins on the IRC side.
        const chanData = bob.chanData(channel, false);
        if (!chanData) {
            throw Error('Expected to have channel data for channel');
        }

        do {
            await delay(500);
        } while (chanData?.users.size < homeserver.users.length)

        // Now check that all the users joined.
        for (const mxUser of usersToJoin) {
            expect(chanData.users.keys()).toContain(`M-${mxUser.localpart}`)
        }
    }, 100_000);
});
