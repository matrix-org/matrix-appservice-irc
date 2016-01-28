"use strict";
var EventEmitter = require("events");
var util = require("util");
var instance = null;

function MockAppService() {
    EventEmitter.call(this);
}
util.inherits(MockAppService, EventEmitter);

MockAppService.prototype.listen = function(port) {
    // NOP
};

MockAppService.prototype._trigger = function(eventType, content) {
    var listeners = instance.listeners(eventType);
    var promises = listeners.map(function(l) {
        return l(content);
    });
    if (promises.length === 1) {
        return promises[0];
    }
    return Promise.all(promises);
};

MockAppService.prototype._queryAlias = function(alias) {
    if (!this.onAliasQuery) {
        throw new Error("IRC AS hasn't hooked into onAliasQuery yet.");
    }
    return this.onAliasQuery(alias);
};

MockAppService.prototype._queryUser = function(user) {
    if (!this.onUserQuery) {
        throw new Error("IRC AS hasn't hooked into onUserQuery yet.");
    }
    return this.onUserQuery(user);
};

function MockAppServiceProxy() {
    if (!instance) {
        instance = new MockAppService();
    }
    return instance;
}
MockAppServiceProxy.instance = function() {
    instance = new MockAppService();
    return instance;
};
MockAppServiceProxy.resetInstance = function() {
    if (instance) {
        instance.removeAllListeners();
    }
    instance = null;
};

module.exports = MockAppServiceProxy;
