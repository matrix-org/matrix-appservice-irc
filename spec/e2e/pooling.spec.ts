import { IrcBridgeE2ETest } from "../util/e2e-test";
import { IrcConnectionPool } from '../../src/pool-service/IrcConnectionPool';

const redisUrl = process.env.IRCBRIDGE_TEST_REDIS_URL ?? 'redis://localhost:6379';

describe('Connection pooling', () => {
    let server: IrcBridgeE2ETest;
    let pool: IrcConnectionPool;
    beforeEach(async () => {
        pool = new IrcConnectionPool({
            redisUri: redisUrl,
            metricsHost: false,
            metricsPort: 7002,
            loggingLevel: 'debug',
        });
        server = await IrcBridgeE2ETest.createTestEnv({
            matrixLocalparts: ['alice'],
            ircNicks: ['bob'],
            config: {
                connectionPool: {
                    redisUrl,
                }
            }
        });
        pool.main();
        await server.setUp();
    });

    afterEach(async () => {
        await Promise.allSettled([
            server.tearDown(),
            pool.close(),
        ]);
    })

    it('should be able to dynamically bridge a room via the !join command', async () => {
        const { homeserver, ircBridge } = server;
        const alice = homeserver.users[0].client;
        const { bob } = server.ircTest.clients;
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
});
