import { IrcBridgeE2ETest } from "../util/e2e-test";


describe('Basic bridge usage', () => {
    let testEnv: IrcBridgeE2ETest;
    beforeEach(async () => {
        testEnv = await IrcBridgeE2ETest.createTestEnv({
            matrixLocalparts: ['alice'],
            ircNicks: ['bob'],
        });
        await testEnv.setUp();
    });
    afterEach(() => {
        return testEnv.tearDown();
    });
    it('should be able to dynamically bridge a room via the !join command', async () => {
        const { homeserver, ircBridge } = testEnv;
        const alice = homeserver.users[0].client;
        const { bob } = testEnv.ircTest.clients;
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
