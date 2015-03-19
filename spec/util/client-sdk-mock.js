/*
 * Mock replacement for 'matrix-js-sdk'.
 */
"use strict";
var suppliedConfig = null;
var mockClient = {};

module.exports.createClient = function(config) {
    suppliedConfig = config;
    return mockClient;
};

module.exports.request = function(requestFn) {
    // ignore the request fn, as that will actually invoke HTTP requests.
};

module.exports._client = function() {
    return mockClient;
};

module.exports._reset = function() {
    suppliedConfig = null;
    mockClient = {
        credentials: {},
        register: jasmine.createSpy("sdk.register(loginType, data)"),
        createRoom: jasmine.createSpy("sdk.createRoom(opts)"),
        joinRoom: jasmine.createSpy("sdk.joinRoom(idOrAlias)"),
        sendMessage: jasmine.createSpy("sdk.sendMessage(roomId, content)"),
        roomState: jasmine.createSpy("sdk.roomState(roomId)"),
        leave: jasmine.createSpy("sdk.leave(roomId)")
    };
};