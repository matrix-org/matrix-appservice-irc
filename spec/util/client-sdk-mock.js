/*
 * Mock replacement for 'matrix-js-sdk'.
 */
"use strict";
var q = require("q");
var suppliedConfig = null;
var mockClient = {};

/**
 * Stub method for creating a new SDK client.
 * @param {Object} config : The SDK client configuration.
 * @return {SdkClient} The SDK client instance.
 */
module.exports.createClient = function(config) {
    suppliedConfig = config;
    return mockClient;
};

/**
 * Stub method for request calls. Does nothing.
 * @param {Function} requestFn
 */
module.exports.request = function(requestFn) {
    // ignore the request fn, as that will actually invoke HTTP requests.
};

/**
 * Get the Matrix Client SDK global instance.
 * @return {SdkClient} The Matrix Client SDK
 */
module.exports._client = function() {
    return mockClient;
};

/**
 * Reset the Matrix Client SDK global instance.
 */
module.exports._reset = function() {
    suppliedConfig = null;
    mockClient = {
        credentials: {},
        _http: {
            opts: {}
        },
        register: jasmine.createSpy("sdk.register(username, password)"),
        createRoom: jasmine.createSpy("sdk.createRoom(opts)"),
        joinRoom: jasmine.createSpy("sdk.joinRoom(idOrAlias, opts)"),
        sendMessage: jasmine.createSpy("sdk.sendMessage(roomId, content)"),
        roomState: jasmine.createSpy("sdk.roomState(roomId)"),
        setRoomTopic: jasmine.createSpy("sdk.setRoomTopic(roomId, topic)"),
        setDisplayName: jasmine.createSpy("sdk.setDisplayName(name)"),
        getStateEvent: jasmine.createSpy("sdk.getStateEvent(room,type,key)"),
        sendStateEvent: jasmine.createSpy("sdk.sendStateEvent(room,type,content,key)"),
        invite: jasmine.createSpy("sdk.invite(roomId, userId)"),
        leave: jasmine.createSpy("sdk.leave(roomId)"),
        createAlias: jasmine.createSpy("sdk.createAlias(alias, roomId)"),
        mxcUrlToHttp: jasmine.createSpy("sdk.mxcUrlToHttp(mxc, w, h, method)")
    };

    // mock up getStateEvent immediately since it is called for every new IRC
    // connection.
    mockClient.getStateEvent.andCallFake(function() {
        return q({});
    });

    // Helper to succeed sdk registration calls.
    mockClient._onHttpRegister = function(params) {
        mockClient.register.andCallFake(function(username, password) {
            expect(username).toEqual(params.expectLocalpart);
            return q({
                user_id: params.returnUserId
            });
        });
        mockClient.setDisplayName.andCallFake(function(name) {
            if (params.andResolve) {
                params.andResolve.resolve();
            }
            return q({});
        });
    };
};
