/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { TestIrcServer } from "matrix-org-irc";
import { IrcBridgeE2ETest } from "../util/e2e-test";
import { describe, it } from "@jest/globals";


describe('Ensure quit messsage is sent', () => {
    let testEnv: IrcBridgeE2ETest;
    beforeEach(async () => {
        testEnv = await IrcBridgeE2ETest.createTestEnv({
            matrixLocalparts: ['alice'],
            ircNicks: ['bob'],
            traceToFile: true,
        });
        await testEnv.setUp();
    });
    afterEach(() => {
        return testEnv?.tearDown();
    });
    it('should update powerlevel of IRC user when OPed by an IRC user', async () => {
        const channel = `#${TestIrcServer.generateUniqueNick("test")}`;
        const { homeserver } = testEnv;
        const [alice] = homeserver.users.map(c => c.client);
        const { bob } = testEnv.ircTest.clients;

        // Create the channel
        await bob.join(channel);
        const adminRoom = await testEnv.createAdminRoomHelper(alice)
        const cRoomId = await testEnv.joinChannelHelper(alice, adminRoom, channel);

        // Ensure we join the IRC side
        await alice.sendText(cRoomId, `Hello world!`);
        await bob.waitForEvent('message', 10000);

        const quitEvent = bob.waitForEvent('quit', 10000);

        // Now, have alice quit.
        await alice.sendText(adminRoom, `!reconnect`);
        const [nick, message, channels] = await quitEvent;
        expect(nick).toEqual('M-alice');
        expect(message).toEqual('Quit: Reconnecting');
        expect(channels).toContain(channel);
    });
});
