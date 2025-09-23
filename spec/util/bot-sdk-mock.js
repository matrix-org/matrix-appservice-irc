/*
 * Mock responses to the matrix-bot-sdk.
 */
const mockIntents = {
    //user_id: MockBotSdkIntent
};

/**
 * A mock of the https://github.com/turt2live/matrix-bot-sdk/blob/master/src/MatrixClient.ts class.
 */
class MockBotSdkClient {
    constructor(userId) {
        this._userId = userId;
        this.createRoom = jasmine.createSpy("cli.createRoom(opts)");
        this.createRoomAlias = jasmine.createSpy("cli.createRoomAlias(alias, roomId)");
        this.doRequest = jasmine.createSpy("cli.doRequest(method, endpoint, query, body)")
        this.getEvent = jasmine.createSpy("cli.getEvent(roomId, eventId)");
        this.getJoinedRooms = jasmine.createSpy("cli.getJoinedRooms()");
        this.getRoomState = jasmine.createSpy("cli.getRoomState(roomId)");
        this.getRoomStateEvent = jasmine.createSpy("cli.getRoomStateEvent(room,type,key)");
        this.getUserProfile = jasmine.createSpy("cli.getUserProfile(userId)");
        this.inviteUser = jasmine.createSpy("cli.inviteUser(userId, roomId)");
        this.joinRoom = jasmine.createSpy("cli.joinRoom(roomId, viaServers)");
        this.kickUser = jasmine.createSpy("cli.kickUser(roomId, target, reason)");
        this.resolveRoom = jasmine.createSpy("cli.resolveRoom(roomIdOrAlias)");
        this.sendEvent = jasmine.createSpy("cli.sendEvent(roomId,type,content)");
        this.sendStateEvent = jasmine.createSpy("cli.sendStateEvent(room,type,key,content)");
        this.setDisplayName = jasmine.createSpy("cli.setDisplayName(name)");
        this.setPresenceStatus = jasmine.createSpy("cli.setPresenceStatus()");
        this.setUserPowerLevel = jasmine.createSpy("cli.setUserPowerLevel(userId, roomId, power)");
        this.getJoinedRoomMembersWithProfiles = jasmine.createSpy("cli.getJoinedRoomMembersWithProfiles()");
        this.getJoinedRoomMembers = jasmine.createSpy("cli.getJoinedRoomMembers()");
        this.uploadContent = jasmine.createSpy("cli.uploadContent()");

        this.getJoinedRooms.and.returnValue(Promise.resolve([]));
        this.resolveRoom.and.callFake((roomIdOrAlias) => {
            if (roomIdOrAlias?.startsWith('!')) {
                return roomIdOrAlias;
            }
            throw Error('Cannot map aliases in this test');
        });

        this.getJoinedRoomMembers.and.returnValue(Promise.resolve([]));
        this.getJoinedRoomMembersWithProfiles.and.returnValue(Promise.resolve({}));

        // Mock these to return empty object
        [
            this.getEvent,
            this.getUserProfile,
            // mock up joinRoom immediately since it is called when joining mapped IRC<-->Matrix rooms
            this.joinRoom,
            this.sendEvent,
            this.sendStateEvent,
            this.setPresenceStatus,
            this.setDisplayName,
        ].map((func) => {
            func.and.returnValue(Promise.resolve({}));
        });

        this.getRoomState.and.callFake(function() {
            return Promise.resolve([]);
        });

        // mock up getRoomStateEvent immediately since it is called for every new IRC
        // connection.
        this.getRoomStateEvent.and.callFake(async (room, type, key) => {
            // Mocks a user having the ability to change power levels
            if (type === 'm.room.power_levels') {
                return {
                    users_default: 100,
                    users : {
                        'powerless': 0
                    },
                    events : {
                        'm.room.power_levels' : 100
                    }
                };
            }
            return {};
        });

    }

    _verifyRegisterRequest(params) {
        this.setDisplayName.and.callFake(function(name) {
            if (params.andResolve) {
                params.andResolve.resolve();
            }
            return Promise.resolve({});
        });
    }

    // Helper to create alias rooms
    _setupRoomByAlias(env, tBotNick, tChannel, tRoomId, tServer, tDomain) {
        const tAliasLocalpart = `irc_${tServer}_${tChannel}`;
        const tAlias = `#${tAliasLocalpart}:${tDomain}`;

        // when we get the connect/join requests, accept them.
        env.ircMock._whenClient(tServer, tBotNick, "join",
            function(_client, chan, cb) {
                if (chan === tChannel) {
                    if (cb) { cb(); }
                }
            }
        );

        this.createRoom.and.returnValue(tRoomId);

        return env.mockAppService._queryAlias(tAlias);
    }

    async getUserId() {
        return this._userId;
    }
}

/**
 * A mock of the https://github.com/turt2live/matrix-bot-sdk/blob/master/src/appservice/Intent.ts class.
 */
class MockBotSdkIntent {
    constructor(config) {
        this.userId = config.userId;
        this.underlyingClient = new MockBotSdkClient(config.userId);
        this.ensureRegistered = jasmine.createSpy("intent.ensureRegistered()");
        this.leaveRoom = jasmine.createSpy("cli.leaveRoom(roomId)");

        this.leaveRoom.and.callFake(() => ({}));

        // mock up registration since we make them if they aren't in the DB (which they won't be
        // for testing).
        this.ensureRegistered.and.callFake(function() {
            return Promise.resolve({});
        });
    }

    // Helper to succeed sdk registration calls.
    _onHttpRegister(params) {
        this.ensureRegistered.and.callFake(() => {
            expect(this.userId.substring(1).split(":")[0]).toEqual(params.expectLocalpart)
        });
        this.underlyingClient._verifyRegisterRequest(params);
    }
}

/**
 * Get/create the Bot SDK Intent instance for a user ID. Called by the test rig.
 * @return {SdkClient} The Matrix Client SDK
 */
function _intent(userId) {
    if (!userId) {
        throw new Error("MockClient: User ID must be specified.");
    }
    if (mockIntents[userId]) {
        return mockIntents[userId];
    }
    mockIntents[userId] = new MockBotSdkIntent({ userId: userId });
    return mockIntents[userId];

}

/**
 * Reset the Matrix Client SDK global instance.
 */
function _reset() {
    Object.keys(mockIntents).forEach((k) => {
        delete mockIntents[k];
    });
}

module.exports = {
    _intent,
    // For legacy reasons
    _client: (userId) => (_intent(userId).underlyingClient),
    _reset,
}
