"use strict";
var EventEmitter = require("events");
var util = require("util");
var instance = null;

function MockAppService() {
    let self = this;

    this.app = {
        post: function(path, handler) {
            if (path === '/_matrix/provision/link') {
                self.link = handler;
            }
            else if (path === '/_matrix/provision/unlink') {
                self.unlink = handler;
            }
            else {
                throw new Error(`Unrecognised path for mock provisioning endpoint "${path}"`);
            }
        },
        get: function(path, handler) {
            //stub
        },
        use: function(req, res, next) {
            //stub
        }
    };

    EventEmitter.call(this);
}
util.inherits(MockAppService, EventEmitter);

// Simulate a request to the link provisioning API
//  parameters {object} - the API request parameters
//  statusCallback {function} - Called when the server returns a HTTP response code.
//  jsonCallback {function} - Called when the server returns a JSON object.
//  link {boolean} - true if this is a link request (false if unlink).
MockAppService.prototype._linkAction = function(parameters, statusCallback, jsonCallback, link) {
    if (link ? !this.link : !this.unlink) {
        throw new Error("IRC AS hasn't hooked into link/unlink yet.");
    }

    let req = {
        body : parameters
    };

    let res = {
        status : function (number) { statusCallback(number); return res;},
        json : function (obj) { jsonCallback(obj); return res;},
    }

    if (link) {
        return this.link(req, res);
    }
    return this.unlink(req, res);
};

MockAppService.prototype._link = function(parameters, statusCallback, jsonCallback) {
    return this._linkAction(parameters, statusCallback, jsonCallback, true);
}

MockAppService.prototype._unlink = function(parameters, statusCallback, jsonCallback) {
    return this._linkAction(parameters, statusCallback, jsonCallback, false);
}


MockAppService.prototype.listen = function(port) {
    // NOP
};

MockAppService.prototype._trigger = function(eventType, content) {
    var listeners = instance.listeners(eventType);
    var promises = listeners.map(function(l) {
        return l(content);
    });

    if (eventType.indexOf("type:") === 0) {
        promises = promises.concat(this._trigger("event", content));
    }

    if (promises.length === 1) {
        return promises[0];
    }
    return Promise.all(promises);
};

MockAppService.prototype._queryAlias = function(alias) {
    if (!this.onAliasQuery) {
        throw new Error("IRC AS hasn't hooked into onAliasQuery yet.");
    }
    return this.onAliasQuery(alias).catch(function(err) {
        console.error("onAliasQuery threw => %s", err);
    });
};

MockAppService.prototype._queryUser = function(user) {
    if (!this.onUserQuery) {
        throw new Error("IRC AS hasn't hooked into onUserQuery yet.");
    }
    return this.onUserQuery(user).catch(function(err) {
        console.error("onUserQuery threw => %s", err);
    });
};

function MockAppServiceProxy() {
    if (!instance) {
        instance = new MockAppService();
    }
    return instance;
}

MockAppServiceProxy.instance = function() {
    if (!instance) {
        instance = new MockAppService();
    }
    return instance;
};

MockAppServiceProxy.resetInstance = function() {
    if (instance) {
        instance.removeAllListeners();
    }
    instance = null;
};

module.exports = MockAppServiceProxy;
