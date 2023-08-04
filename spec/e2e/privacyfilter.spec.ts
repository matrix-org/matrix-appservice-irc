import { TestIrcServer } from "matrix-org-irc";
import { IrcBridgeE2ETest } from "../util/e2e-test";
import { describe, it, expect } from "@jest/globals";


describe('Connection pooling', () => {
    let testEnv: IrcBridgeE2ETest;

    beforeEach(async () => {
        const alice = TestIrcServer.generateUniqueNick('alice');
        const bannedUser = TestIrcServer.generateUniqueNick('banneduser');
        // Initial run of the bridge to setup a testing environment
        testEnv = await IrcBridgeE2ETest.createTestEnv({
            matrixLocalparts: [alice, bannedUser],
            ircNicks: ['bob'],
            ircServerConfig: {
                membershipLists: {
                    enabled: true,
                    floodDelayMs: 100,
                    global: {
                        ircToMatrix: {
                            incremental: true,
                            initial: true,
                            requireMatrixJoined: true,
                        },
                        matrixToIrc: {
                            incremental: true,
                            initial: true,
                        }
                    }
                },
                excludedUsers: [{
                    regex: `@${bannedUser}.*`,
                    kickReason: 'Test kick',
                }]
            }
        });
        await testEnv.setUp();
    });

    // Ensure we always tear down
    afterEach(() => {
        return testEnv.tearDown();
    });

    it('should be able to send a message with the privacy filter on', async () => {
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
    });

    it('should not bridge messages with an excluded user', async () => {
        const channel = `#${TestIrcServer.generateUniqueNick("test")}`;

        const { homeserver } = testEnv;
        const alice = homeserver.users[0].client;
        const bannedUser = homeserver.users[1].client;
        const { bob } = testEnv.ircTest.clients;

        // Create the channel
        await bob.join(channel);

        const adminRoomId = await testEnv.createAdminRoomHelper(alice);
        const cRoomId = await testEnv.createProvisionedRoom(alice, adminRoomId, channel, false);

        // And finally wait for bob to appear.
        const bobUserId = `@irc_${bob.nick}:${homeserver.domain}`;
        await alice.waitForRoomEvent(
            {eventType: 'm.room.member', sender: bobUserId, stateKey: bobUserId, roomId: cRoomId}
        );
        const aliceMsg = bob.waitForEvent('message', 10000);
        alice.sendText(cRoomId, "Hello bob!");
        await aliceMsg;

        // Note, the bridge can't kick bannedUser due to lacking perms.
        await bannedUser.joinRoom(cRoomId);
        const message = alice.waitForRoomEvent(
            {eventType: 'm.room.message', sender: bobUserId, roomId: cRoomId}
        );
        const connectionStateEv = alice.waitForRoomEvent({
            eventType: 'org.matrix.appservice-irc.connection',
            sender: testEnv.ircBridge.appServiceUserId,
            roomId: cRoomId
        });
        await bob.say(channel, "Hi alice!");
        try {
            await message;
            throw Error('Expected message to not be viewable.');
        }
        catch (ex) {
            if (!ex.message.startsWith(`Timed out waiting for m.room.message from ${bobUserId} in ${cRoomId}`)) {
                throw ex;
            }
        }
        const connectionEventData = (await connectionStateEv).data;
        expect(connectionEventData.content.blocked).toBe(true);
    });

    fit('should unblock a blocked channel if all excluded users leave', async () => {
        const channel = `#${TestIrcServer.generateUniqueNick("test")}`;

        const { homeserver } = testEnv;
        const alice = homeserver.users[0].client;
        const bannedUser = homeserver.users[1].client;
        const { bob } = testEnv.ircTest.clients;

        // Create the channel
        await bob.join(channel);

        const adminRoomId = await testEnv.createAdminRoomHelper(alice);
        const cRoomId = await testEnv.createProvisionedRoom(alice, adminRoomId, channel, false);

        // And finally wait for bob to appear.
        const bobUserId = `@irc_${bob.nick}:${homeserver.domain}`;
        await alice.waitForRoomEvent(
            {eventType: 'm.room.member', sender: bobUserId, stateKey: bobUserId, roomId: cRoomId}
        );
        const aliceMsg = bob.waitForEvent('message', 10000);
        alice.sendText(cRoomId, "Hello bob!");
        await aliceMsg;

        // Note, the bridge can't kick bannedUser due to lacking perms.
        await bannedUser.joinRoom(cRoomId);
        const connectionStateEv = alice.waitForRoomEvent({
            eventType: 'org.matrix.appservice-irc.connection',
            sender: testEnv.ircBridge.appServiceUserId,
            roomId: cRoomId
        });
        await bob.say(channel, "Hi alice!");
        const connectionEventData = (await connectionStateEv).data;
        expect(connectionEventData.content.blocked).toBe(true);

        await bannedUser.leaveRoom(cRoomId);
        const bobMsg = alice.waitForRoomEvent(
            {eventType: 'm.room.message', sender: bobUserId, roomId: cRoomId}
        );
        const connectionStateEvUnblocked = alice.waitForRoomEvent({
            eventType: 'org.matrix.appservice-irc.connection',
            sender: testEnv.ircBridge.appServiceUserId,
            roomId: cRoomId
        });
        await bob.say(channel, "Hi alice!");

        const connectionEventDataUnblocked = (await connectionStateEvUnblocked).data;
        expect(connectionEventDataUnblocked.content.blocked).toBe(false);
        await bobMsg;
    });
});
