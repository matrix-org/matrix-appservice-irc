import { IrcBridgeE2ETest } from "../util/e2e-test";


xdescribe('Basic bridge usage', () => {
    let server: IrcBridgeE2ETest;
    beforeEach(async () => {
        server = await IrcBridgeE2ETest.createTestEnv({
            matrixLocalparts: ['alice'],
            ircNicks: ['bob'],
        });
        await server.setUp();
    });
    afterEach(() => {
        return server.tearDown();
    });
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
