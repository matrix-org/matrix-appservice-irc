const envBundle = require("../util/env-bundle");

describe("Invite-only rooms", () => {
    const {env, config, roomMapping, botUserId, test} = envBundle();
    const testUser = {
        id: "@flibble:wibble",
        nick: "flibble"
    };
    const testIrcUser = {
        localpart: roomMapping.server + "_foobar",
        id: "@" + roomMapping.server + "_foobar:" + config.homeserver.domain,
        nick: "foobar"
    };


    beforeEach(async () => {
        await test.beforeEach(env);

        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );

        await test.initEnv(env);
    });

    afterEach(async () => {
        await test.afterEach(env);
    });

    it("should be joined by the bot if the AS does know the room ID", async () => {
        const adminRoomId = "!adminroom:id";
        const sdk = env.clientMock._client(botUserId);
        let joinRoomCount = 0;
        sdk.joinRoom.and.callFake(async (roomId) => {
            expect(roomId).toEqual(adminRoomId);
            joinRoomCount += 1;
            return {roomId};
        });

        await env.mockAppService._trigger("type:m.room.member", {
            content: {
                membership: "invite",
                is_direct: true,
            },
            state_key: botUserId,
            user_id: testUser.id,
            room_id: adminRoomId,
            type: "m.room.member"
        });
        expect(joinRoomCount).withContext("Failed to join admin room").toEqual(1);
        // inviting them AGAIN to an existing known ADMIN room should trigger a join
        await env.mockAppService._trigger("type:m.room.member", {
            content: {
                membership: "invite",
                is_direct: true,
            },
            state_key: botUserId,
            user_id: testUser.id,
            room_id: adminRoomId,
            type: "m.room.member"
        });
        expect(joinRoomCount).toEqual(2, "Failed to join admin room again");
    });

    it("should be joined by a virtual IRC user if the bot invited them, " +
        "regardless of the number of people in the room.", async () => {
        // when it queries whois, say they exist
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "whois", (client, nick, cb) => {
            expect(nick).toEqual(testIrcUser.nick);
            // say they exist (presence of user key)
            cb({
                user: testIrcUser.nick,
                nick: testIrcUser.nick
            });
        });

        const intent = env.clientMock._intent(testIrcUser.id);
        // if it tries to register, accept.
        intent._onHttpRegister({
            expectLocalpart: testIrcUser.localpart,
            returnUserId: testIrcUser.id
        });
        const sdk = intent.underlyingClient;

        let joinedRoom = false;
        sdk.joinRoom.and.callFake((roomId) => {
            expect(roomId).toEqual(roomMapping.roomId);
            joinedRoom = true;
        });

        let leftRoom = false;
        sdk.kickUser.and.callFake((_kickee, roomId) => {
            expect(roomId).toEqual(roomMapping.roomId);
            leftRoom = true;
            return {};
        });

        let askedForRoomState = false;
        sdk.getRoomState.and.callFake((roomId) => {
            expect(roomId).toEqual(roomMapping.roomId);
            askedForRoomState = true;
            return [
                {
                    content: {membership: "join"},
                    user_id: botUserId,
                    state_key: botUserId,
                    room_id: roomMapping.roomId,
                    type: "m.room.member"
                },
                {
                    content: {membership: "join"},
                    user_id: testIrcUser.id,
                    state_key: testIrcUser.id,
                    room_id: roomMapping.roomId,
                    type: "m.room.member"
                },
                // Group chat, so >2 users!
                {
                    content: {membership: "join"},
                    user_id: "@someone:else",
                    state_key: "@someone:else",
                    room_id: roomMapping.roomId,
                    type: "m.room.member"
                },
            ];
        });

        await env.mockAppService._trigger("type:m.room.member", {
            content: {
                membership: "invite",
            },
            state_key: testIrcUser.id,
            user_id: botUserId,
            room_id: roomMapping.roomId,
            type: "m.room.member"
        });
        expect(joinedRoom).toBe(true);
        expect(leftRoom).toBe(false);
        // should go off the fact that the inviter was the bot
        expect(askedForRoomState).toBe(false);
    });
});
