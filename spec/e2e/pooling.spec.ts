import { IrcBridgeE2ETest } from "../util/e2e-test";
import { it, expect } from '@jest/globals';

IrcBridgeE2ETest.describeTest('Basic bridge usage', (env) => {
    it('should be able to dynamically bridge a room via the !join command', async () => {
        const { homeserver, ircBridge, clients } = env();
        const alice = homeserver.users[0].client;
        const bob = clients[0];
        await bob.join('#test');

        const adminRoomId = await alice.createRoom({
            is_direct: true,
            invite: [ircBridge.appServiceUserId],
        });
        await alice.waitForRoomEvent(
            {eventType: 'm.room.member', sender: ircBridge.appServiceUserId, roomId: adminRoomId}
        );
        await alice.sendText(adminRoomId, `!join #test`);
        const invite = await alice.waitForRoomInvite(
            {sender: ircBridge.appServiceUserId}
        );
        const cRoomId = invite.roomId;
        await alice.joinRoom(cRoomId);
        const roomName = await alice.getRoomStateEvent(cRoomId, 'm.room.name', '');
        expect(roomName.name).toEqual('#test');
        // And finally wait for bob to appear.
        const bobUserId = `@irc_${bob.nick}:${homeserver.domain}`;
        await alice.waitForRoomEvent(
            {eventType: 'm.room.member', sender: bobUserId, stateKey: bobUserId, roomId: cRoomId}
        );
    });
}, {
    matrixLocalparts: ['alice'],
    clients: ['bob'],
    config: {
        connectionPool: {
            redisUrl: process.env.IRCBRIDGE_TEST_REDIS_URL ?? 'redis://localhost:6379',
            persistConnectionsOnShutdown: false,
        }
    }
});
