import { TestIrcServer } from "matrix-org-irc";
import { IrcBridgeE2ETest } from "../util/e2e-test";
import { describe, expect, it } from "@jest/globals";


describe('Reply handling', () => {
    let testEnv: IrcBridgeE2ETest;
    let charlieMxid: string;
    beforeEach(async () => {
        charlieMxid = TestIrcServer.generateUniqueNick("charlie");
        testEnv = await IrcBridgeE2ETest.createTestEnv({
            matrixLocalparts: [TestIrcServer.generateUniqueNick("alice"), charlieMxid],
            ircNicks: ['bob'],
            traceToFile: true,
        });
        await testEnv.setUp();
    });
    afterEach(() => {
        return testEnv?.tearDown();
    });
    it('should not leak the contents of messages to new joiners', async () => {
        const channel = `#${TestIrcServer.generateUniqueNick("test")}`;
        const { homeserver, ircBridge } = testEnv;
        const [alice, charlie] = homeserver.users.map(u => u.client);
        const { bob } = testEnv.ircTest.clients;

        // Create the channel
        await bob.join(channel);

        const adminRoomId = await testEnv.createAdminRoomHelper(alice);
        const cRoomId = await testEnv.joinChannelHelper(alice, adminRoomId, channel);
        const roomName = await alice.getRoomStateEvent(cRoomId, 'm.room.name', '');
        expect(roomName.name).toEqual(channel);

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
        const aliceMsgBody = "Hello bib!";
        const aliceEventId = alice.sendText(cRoomId, aliceMsgBody);
        await aliceMsg;
        bob.say(channel, "Hi alice!");
        await bobMsg;

        // Now charlie joins and tries to reply to alice.
        await charlie.joinRoom(cRoomId);
        const charlieMsgIrcPromise = bob.waitForEvent('message', 10000);
        await charlie.replyText(cRoomId, {
            event_id: await aliceEventId,
        }, "Sneaky reply to a message I have not seen");

        // Safety check to ensure that we're using the long form reply format.
        expect(ircBridge.config.ircService.matrixHandler?.shortReplyTresholdSeconds).toBe(0);
        // The long form reply format should not contain alice's message.
        const charlieIrcMessage = (await charlieMsgIrcPromise)[2];
        expect(charlieIrcMessage).not.toContain(aliceMsgBody);

        // Now check that alice can reply, as they have been in the room long enough.
        const aliceReplyMsgPromise = bob.waitForEvent('message', 10000);
        await alice.replyText(cRoomId, {
            event_id: await aliceEventId,
        }, "Oh sorry, I meant bob!");
        expect((await aliceReplyMsgPromise)[2]).toContain(aliceMsgBody);

    });
});
