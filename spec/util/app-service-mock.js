"use strict";
const EventEmitter = require("events");
const util = require("util");
const { createRequest, createResponse } = require("node-mocks-http");
const config = require("./test-config.json");
var instance = null;

function MockAppService() {
    this.expressApp = {
        get: () => {},
        post: () => {},
        use: (path, router) => {
            if (path === "/_matrix/provision") {
                // The provisioner router.
                this.provisionerRouter = router;
            }
        }
    };

    EventEmitter.call(this);
}
util.inherits(MockAppService, EventEmitter);

MockAppService.prototype._mockApiCall = async function mockApiCall(opts) {
    if (!this.provisionerRouter) {
        throw new Error("Provisioner router has not been added yet");
    }

    const request = createRequest({
        headers: {
            "authorization": `Bearer ${config.ircService.provisioning.secret}`,
        },
        ...opts,
    });

    return new Promise((resolve, reject) => {
        const response = createResponse({
            eventEmitter: EventEmitter,
        });
        this.provisionerRouter(
            request,
            response,
            () => {
                // no-op
            },
        );
        response.on("end", () => {
            return resolve(response);
        });
    });
}

MockAppService.prototype._link = function(body) {
    return this._mockApiCall({
        method: "POST",
        url: "/link",
        body,
    });
}

MockAppService.prototype._unlink = function(body) {
    return this._mockApiCall({
        method: "POST",
        url: "/unlink",
        body,
    });
}

MockAppService.prototype._listLinks = function(query) {
    return this._mockApiCall({
        method: "GET",
        url: `/listlinks/${encodeURIComponent(query.roomId)}`,
    });
}

MockAppService.prototype.listen = function(port) {
    // NOP
};

MockAppService.prototype._trigger = function(eventType, content) {
    if (content.user_id) {
        content.sender = content.user_id;
    }
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

MockAppService.prototype.close = async function() { /* No-op */ };

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
