/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { TestIrcServer } from "matrix-org-irc";
import { IrcBridgeE2ETest } from "../util/e2e-test";
import { describe, it } from "@jest/globals";

const MEMBERSHIP_TIMEOUT = 3000;

describe('Ensure membership is synced to IRC rooms', () => {
    let testEnv: IrcBridgeE2ETest;
    beforeEach(async () => {
        testEnv = await IrcBridgeE2ETest.createTestEnv({
            matrixLocalparts: ['alice'],
            ircNicks: ['bob', 'charlie', 'basil'].flatMap(nick => Array.from({length: 1}, (_, i) => `${nick}${i}`)),
        });
        await testEnv.setUp();
    });
    afterEach(() => {
        return testEnv?.tearDown();
    });
    it('ensure IRC puppets join', async () => {
        const channel = `#${TestIrcServer.generateUniqueNick("test")}`;
        const { homeserver } = testEnv;
        const alice = homeserver.users[0].client;
        const clients = Object.values(testEnv.ircTest.clients)
            .map(client => ({userId: `@irc_${client.nick}:${homeserver.domain}`, client}));
        const creatorClient = clients.pop()!;

        // Create the channel
        await creatorClient.client.join(channel);

        const cRoomId = await testEnv.joinChannelHelper(alice, await testEnv.createAdminRoomHelper(alice), channel);

        const joinPromises: Promise<unknown>[] = [];

        // Join all the users, and check all the membership events appear.
        for (const ircUser of clients) {
            joinPromises.push(
                alice.waitForRoomEvent(
                    {eventType: 'm.room.member', sender: ircUser.userId, stateKey: ircUser.userId, roomId: cRoomId},
                    MEMBERSHIP_TIMEOUT,
                )
            )
            await ircUser.client.join(channel);
        }

        await Promise.all(joinPromises);
    });

    it('ensure IRC puppets leave on part', async () => {
        const channel = `#${TestIrcServer.generateUniqueNick("test")}`;
        const { homeserver } = testEnv;
        const alice = homeserver.users[0].client;
        const clients = Object.values(testEnv.ircTest.clients)
            .map(client => ({userId: `@irc_${client.nick}:${homeserver.domain}`, client}));
        const creatorClient = clients.pop()!;

        // Create the channel
        await creatorClient.client.join(channel);

        const cRoomId = await testEnv.joinChannelHelper(alice, await testEnv.createAdminRoomHelper(alice), channel);

        const joinPromises: Promise<unknown>[] = [];

        // Join all the users, and check all the membership events appear.
        for (const ircUser of clients) {
            joinPromises.push(
                alice.waitForRoomEvent(
                    {eventType: 'm.room.member', sender: ircUser.userId, stateKey: ircUser.userId, roomId: cRoomId},
                    MEMBERSHIP_TIMEOUT,
                )
            )
            await ircUser.client.join(channel);
        }

        await Promise.all(joinPromises);
        const partPromises: Promise<unknown>[] = [];

        for (const ircUser of clients) {
            partPromises.push(
                alice.waitForRoomEvent(
                    {eventType: 'm.room.member', sender: ircUser.userId, stateKey: ircUser.userId, roomId: cRoomId},
                    MEMBERSHIP_TIMEOUT,
                )
            )
            await ircUser.client.part(channel, 'getting out of here!');
        }
        await Promise.all(partPromises);
    });

    it('ensure IRC puppets leave on quit', async () => {
        const channel = `#${TestIrcServer.generateUniqueNick("test")}`;
        const { homeserver } = testEnv;
        const alice = homeserver.users[0].client;
        const clients = Object.values(testEnv.ircTest.clients)
            .map(client => ({userId: `@irc_${client.nick}:${homeserver.domain}`, client}));
        const creatorClient = clients.pop()!;

        // Create the channel
        await creatorClient.client.join(channel);

        const cRoomId = await testEnv.joinChannelHelper(alice, await testEnv.createAdminRoomHelper(alice), channel);

        const joinPromises: Promise<unknown>[] = [];

        // Join all the users, and check all the membership events appear.
        for (const ircUser of clients) {
            joinPromises.push(
                alice.waitForRoomEvent(
                    {eventType: 'm.room.member', sender: ircUser.userId, stateKey: ircUser.userId, roomId: cRoomId},
                    MEMBERSHIP_TIMEOUT,
                )
            )
            await ircUser.client.join(channel);
        }

        await Promise.all(joinPromises);
        const partPromises: Promise<unknown>[] = [];

        for (const ircUser of clients) {
            partPromises.push(
                alice.waitForRoomEvent(
                    {eventType: 'm.room.member', sender: ircUser.userId, stateKey: ircUser.userId, roomId: cRoomId},
                    MEMBERSHIP_TIMEOUT,
                )
            )
            await ircUser.client.disconnect();
        }
        await Promise.all(partPromises);
    });
});
