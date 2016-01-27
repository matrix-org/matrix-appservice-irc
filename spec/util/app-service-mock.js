"use strict";
var EventEmitter = require("events");

class MockAppService extends EventEmitter {
    constructor(obj) {
        this.obj = obj;
    }

    listen(port) {
        // NOP
    }

    _trigger(eventType, content) {
        var promises = [];
        var listeners = this.listeners(eventType);
        listeners.forEach(function(l) {
            promises.push(l(content));
        })
        if (promises.length === 1) {
            return promises[0];
        }
        return Promise.all(promises);
    }

    _queryAlias(alias) {
        return this.onAliasQuery(alias);
    }

    _queryUser(user) {
        return this.onUserQuery(user);
    }
}

module.exports = MockAppService;
