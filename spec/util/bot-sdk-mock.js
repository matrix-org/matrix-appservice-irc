/*
 * Mock responses to the matrix-bot-sdk.
 */
const mockIntents = {
    //user_id: Client
};

class MockBotSdkClient {
    constructor(userId) {
        this._userId = userId;
        this.createRoomAlias = jasmine.createSpy("cli.createRoomAlias(alias, roomId)");
        this.createRoom = jasmine.createSpy("cli.createRoom(opts)");
        this.doRequest = jasmine.createSpy("cli.doRequest(method, endpoint, query, body)")
        this.getJoinedRooms = jasmine.createSpy("cli.getJoinedRooms()");
        this.getRoomState = jasmine.createSpy("cli.getRoomState(roomId)");
        this.getRoomStateEvent = jasmine.createSpy("cli.getRoomStateEvent(room,type,key)");
        this.getUserProfile = jasmine.createSpy("cli.getUserProfile(userId)");
        this.inviteUser = jasmine.createSpy("cli.inviteUser(userId, roomId)");
        this.joinRoom = jasmine.createSpy("cli.joinRoom(roomId, viaServers)");
        this.leaveRoom = jasmine.createSpy("cli.leaveRoom(roomId)");
        this.resolveRoom = jasmine.createSpy("cli.resolveRoom(roomIdOrAlias)");
        this.sendEvent = jasmine.createSpy("cli.sendEvent(roomId,type,content)");
        this.sendStateEvent = jasmine.createSpy("cli.sendStateEvent(room,type,content,key)");
        this.setDisplayName = jasmine.createSpy("cli.setDisplayName(name)");
        this.setUserPowerLevel = jasmine.createSpy("cli.setUserPowerLevel(userId, roomId, power)");
        this.kickUser = jasmine.createSpy("cli.kickUser(roomId, target, reason)");

        this.getJoinedRooms.and.returnValue(Promise.resolve([]));
        this.resolveRoom.and.callFake((roomIdOrAlias) => {
            if (roomIdOrAlias?.startsWith('!')) {
                return roomIdOrAlias;
            }
            throw Error('Cannot map aliases in this test');
        });

        // Mock these to return empty object
        [
            // mock up joinRoom immediately since it is called when joining mapped IRC<-->Matrix rooms
            this.getUserProfile,
            this.joinRoom,
            this.leaveRoom,
            this.sendEvent,
            this.sendStateEvent,
        ].map((func) => {
            func.and.callFake(async () => {
                return {};
            });
        });

        this.getRoomState.and.callFake(function() {
            return Promise.resolve([]);
        });

        // mock up getStateEvent immediately since it is called for every new IRC
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

    async getUserId() {
        return this._userId;
    }
}

/**
 * A mock of the https://github.com/turt2live/matrix-bot-sdk/blob/master/src/appservice/Intent.ts class
 *
 * This also includes a mock to the the underlying
 * https://github.com/turt2live/matrix-bot-sdk/blob/master/src/MatrixClient.ts calls.
 */
class MockBotSdkIntent {
    constructor(config) {
        this.userId = config.userId;
        this.underlyingClient = new MockBotSdkClient(config.userId);
        this.createRoom = jasmine.createSpy("sdk.createRoom(opts)");
        this.joinRoom = jasmine.createSpy("sdk.joinRoom(idOrAlias, opts)");
        this.sendMessage = jasmine.createSpy("sdk.sendMessage(roomId, content)");
        this.setRoomTopic = jasmine.createSpy("sdk.setRoomTopic(roomId, topic)");
        this.getStateEvent = jasmine.createSpy("sdk.getStateEvent(room,type,key)");
        this.fetchRoomEvent = jasmine.createSpy("sdk.fetchRoomEvent(room,event_id)");
        this.invite = jasmine.createSpy("sdk.invite(roomId, userId)");
        this.mxcUrlToHttp = jasmine.createSpy("sdk.mxcUrlToHttp(mxc, w, h, method)");
        this.getHomeserverUrl = jasmine.createSpy("sdk.getHomeserverUrl()");
        this.setPowerLevel = jasmine.createSpy("sdk.setPowerLevel()");
        this.setPresence = jasmine.createSpy("sdk.setPresence()");
        this.getJoinedRoomMembers = jasmine.createSpy("sdk.getJoinedRoomMembers()");
        this.fetchRoomEvent = jasmine.createSpy("sdk.fetchRoomEvent()");
        this.uploadContent = jasmine.createSpy("sdk.uploadContent()");
        this.ensureRegistered = jasmine.createSpy("intent.ensureRegistered()");

        this.setPresence.and.returnValue(Promise.resolve({}));
        // mock up joinRoom immediately since it is called when joining mapped IRC<-->Matrix rooms
        this.joinRoom.and.callFake(function() {
            return Promise.resolve({});
        });


        this.getJoinedRoomMembers.and.returnValue(Promise.resolve([]));

        this.fetchRoomEvent.and.callFake(() => {
            return Promise.resolve({});
        });

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

    // Helper to create alias rooms
    _setupRoomByAlias(env, tBotNick, tChannel, tRoomId, tServer, tDomain) {
        const tAliasLocalpart = "irc_" + tServer + "_" + tChannel;
        const tAlias = "#" + tAliasLocalpart + ":" + tDomain;

        // when we get the connect/join requests, accept them.
        env.ircMock._whenClient(tServer, tBotNick, "join",
            function(client, chan, cb) {
                if (chan === tChannel) {
                    if (cb) { cb(); }
                }
            }
        );

        this.createRoom.and.callFake(function(opts) {
            return Promise.resolve({
                room_id: tRoomId
            });
        });

        this.sendStateEvent.and.callFake(function(roomId, eventType, obj) {
            return Promise.resolve({});
        });

        return env.mockAppService._queryAlias(tAlias);
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
    console.log(mockIntents);
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
