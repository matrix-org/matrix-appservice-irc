/*
 * Mock replacement for 'matrix-js-sdk'.
 */
"use strict";
var suppliedConfig = null;
var mockClient = null;

module.exports.createClient = function(config) {
    suppliedConfig = config;
    return mockClient;
};

module.exports.request = function(requestFn) {
    // ignore the request fn, as that will actually invoke HTTP requests.
};

module.exports._regenerate = function() {
    mockClient = {
        credentials: {},
        sendMessage: function(){}
    };
};

module.exports._client = function() {
    return mockClient;
}