/*
 * Mock replacement for 'matrix-js-sdk'.
 */
"use strict";
var Promise = require("bluebird");
var mockClients = {
    //user_id: Client
};

function MockClient(config) {
    var self = this;
    this.credentials = {
        userId: config.userId
    };
    this._http = { opts: {} };
    this.register = jasmine.createSpy("sdk.register(username, password)");
    this.createRoom = jasmine.createSpy("sdk.createRoom(opts)");
    this.joinRoom = jasmine.createSpy("sdk.joinRoom(idOrAlias, opts)");
    this.sendMessage = jasmine.createSpy("sdk.sendMessage(roomId, content)");
    this.roomState = jasmine.createSpy("sdk.roomState(roomId)");
    this.setRoomTopic = jasmine.createSpy("sdk.setRoomTopic(roomId, topic)");
    this.setDisplayName = jasmine.createSpy("sdk.setDisplayName(name)");
    this.getStateEvent = jasmine.createSpy("sdk.getStateEvent(room,type,key)");
    this.sendStateEvent = jasmine.createSpy("sdk.sendStateEvent(room,type,content,key)");
    this.sendEvent = jasmine.createSpy("sdk.sendEvent(roomId,type,content)");
    this.invite = jasmine.createSpy("sdk.invite(roomId, userId)");
    this.leave = jasmine.createSpy("sdk.leave(roomId)");
    this.kick = jasmine.createSpy("sdk.kick(roomId, target)");
    this.createAlias = jasmine.createSpy("sdk.createAlias(alias, roomId)");
    this.mxcUrlToHttp = jasmine.createSpy("sdk.mxcUrlToHttp(mxc, w, h, method)");

    // mock up joinRoom immediately since it is called when joining mapped IRC<-->Matrix rooms
    this.joinRoom.andCallFake(function() {
        return Promise.resolve({});
    });

    // mock up getStateEvent immediately since it is called for every new IRC
    // connection.
    this.getStateEvent.andCallFake(function() {
        return Promise.resolve({});
    });

    // mock up registration since we make them if they aren't in the DB (which they won't be
    // for testing).
    this.register.andCallFake(function() {
        return Promise.resolve({});
    });

    // Helper to succeed sdk registration calls.
    this._onHttpRegister = function(params) {
        self.register.andCallFake(function(username, password) {
            expect(username).toEqual(params.expectLocalpart);
            return Promise.resolve({
                user_id: params.returnUserId
            });
        });
        self.setDisplayName.andCallFake(function(name) {
            if (params.andResolve) {
                params.andResolve.resolve();
            }
            return Promise.resolve({});
        });
    };
}

/**
 * Stub method for creating a new SDK client. Called by the IRC Bridge.
 * @param {Object} config : The SDK client configuration.
 * @return {SdkClient} The SDK client instance.
 */
module.exports.createClient = function(config) {
    if (mockClients[config.userId]) {
        return mockClients[config.userId];
    }
    var client = new MockClient(config);
    mockClients[config.userId] = client;
    return client;
};

/**
 * Stub method for request calls. Does nothing.
 * @param {Function} requestFn
 */
module.exports.request = function(requestFn) {
    // ignore the request fn, as that will actually invoke HTTP requests.
};

/**
 * Get/create the Matrix Client SDK instance for a user ID. Called by the test rig.
 * @return {SdkClient} The Matrix Client SDK
 */
module.exports._client = function(userId) {
    if (!userId) {
        throw new Error("MockClient: User ID must be specified.");
    }
    return module.exports.createClient({ userId: userId });
};

/**
 * Reset the Matrix Client SDK global instance.
 */
module.exports._reset = function() {
    mockClients = {};
};
