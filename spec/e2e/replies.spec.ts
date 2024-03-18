import { TestIrcServer } from "matrix-org-irc";
import { IrcBridgeE2ETest } from "../util/e2e-test";
import { describe, expect, it } from "@jest/globals";


describe('Reply handling', () => {
    let testEnv: IrcBridgeE2ETest;
    async function setupTestEnv(shortReplyTresholdSeconds: number) {
        testEnv = await IrcBridgeE2ETest.createTestEnv({
            matrixLocalparts: [TestIrcServer.generateUniqueNick("alice"), TestIrcServer.generateUniqueNick("charlie")],
            ircNicks: ['bob'],
            traceToFile: true,
            shortReplyTresholdSeconds,
        });
        await testEnv.setUp();
    }
    afterEach(() => {
        return testEnv?.tearDown();
    });

    it('should use short and long reply formats, depending on elapsed time', async () => {
        await setupTestEnv(1);

        const channel = `#${TestIrcServer.generateUniqueNick("test")}`;
        const { homeserver } = testEnv;
        const [alice, charlie] = homeserver.users.map(u => u.client);
        const { bob } = testEnv.ircTest.clients;

        await bob.join(channel);

        const adminRoomId = await testEnv.createAdminRoomHelper(alice);
        const cRoomId = await testEnv.joinChannelHelper(alice, adminRoomId, channel);
        await charlie.joinRoom(cRoomId);

        const bobUserId = `@irc_${bob.nick}:${homeserver.domain}`;
        await alice.waitForRoomEvent(
            {eventType: 'm.room.member', sender: bobUserId, stateKey: bobUserId, roomId: cRoomId}
        );

        // first message is always a bit delayed, so let's send&await it ahead of time before we get to testing
        let bridgedMessage = bob.waitForEvent('message', 10000);
        await alice.sendText(cRoomId, "warming up...");
        await bridgedMessage;

        const originalMessageBody = "Original message";
        bridgedMessage = bob.waitForEvent('message', 10000);
        const originalMessageId = await alice.sendText(cRoomId, originalMessageBody);
        await bridgedMessage;

        bridgedMessage = bob.waitForEvent('message', 10000);
        await charlie.replyText(cRoomId, {
            event_id: originalMessageId,
        }, "Short reply");
        let ircMessage = await bridgedMessage;

        expect(ircMessage[2]).toContain("Short reply");
        expect(ircMessage[2]).not.toContain("Original message");

        await new Promise(r => setTimeout(r, 1000));

        bridgedMessage = bob.waitForEvent('message', 10000);
        await charlie.replyText(cRoomId, {
            event_id: originalMessageId,
        }, "Long reply");
        ircMessage = await bridgedMessage;

        expect(ircMessage[2]).toContain("Long reply");
        expect(ircMessage[2]).toContain("Original message");
    });
});
