/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { TestIrcServer } from "matrix-org-irc";
import { IrcBridgeE2ETest } from "../util/e2e-test";
import { describe, expect, it } from "@jest/globals";
import { PowerLevelContent } from "matrix-appservice-bridge";


describe('Ensure powerlevels are appropriately applied', () => {
    let testEnv: IrcBridgeE2ETest;
    beforeEach(async () => {
        testEnv = await IrcBridgeE2ETest.createTestEnv({
            matrixLocalparts: ['alice'],
            ircNicks: ['bob', 'charlie'],
        });
        await testEnv.setUp();
    });
    afterEach(() => {
        return testEnv?.tearDown();
    });
    it('should update powerlevel of IRC user when OPed by an IRC user', async () => {
        const channel = `#${TestIrcServer.generateUniqueNick("test")}`;
        const { homeserver } = testEnv;
        const alice = homeserver.users[0].client;
        const { bob, charlie } = testEnv.ircTest.clients;
        const charlieUserId = `@irc_${charlie.nick}:${homeserver.domain}`;

        // Create the channel
        await bob.join(channel);

        const cRoomId = await testEnv.joinChannelHelper(alice, await testEnv.createAdminRoomHelper(alice), channel);

        // Now have charlie join and be opped.
        await charlie.join(channel);
        await alice.waitForRoomEvent(
            {eventType: 'm.room.member', sender: charlieUserId, stateKey: charlieUserId, roomId: cRoomId}
        );
        await bob.send('MODE', channel, '+o', charlie.nick);
        const powerLevel = alice.waitForRoomEvent<PowerLevelContent>(
            {eventType: 'm.room.power_levels', roomId: cRoomId, sender: testEnv.ircBridge.appServiceUserId}
        );

        const powerlevelContent = (await powerLevel).data.content;
        console.log(powerlevelContent.users);
        expect(powerlevelContent.users![charlieUserId]).toEqual(
            testEnv.ircBridge.config.ircService.servers.localhost.modePowerMap!.o
        );
    });
});