"use strict";
const EventEmitter = require("events");
const util = require("util");
const { createRequest, createResponse } = require('node-mocks-http');
const config = require('./test-config.json');
var instance = null;

function MockAppService() {
    this.expressApp = {
        get: () => {},
        post: () => {},
        use: (path, router) => {
            if (path === '/_matrix/provision') {
                // The provisioner router.
                this.provisionerRouter = router;
            }
        }
    };

    EventEmitter.call(this);
}
util.inherits(MockAppService, EventEmitter);

MockAppService.prototype._mockApiCall = async function mockApiCall(data, statusCallback, jsonCallback, link) {
    if (!this.provisionerRouter) {
        throw new Error("IRC AS hasn't hooked into link/unlink yet.");
    }

    const request = createRequest({
        method: data.method,
        url: data.url,
        body: data.body,
        headers: {
            'authorization': `Bearer ${config.ircService.provisioning.secret}`,
        }
    });

    return new Promise((res, rej) => {
        const response = createResponse({
            eventEmitter: EventEmitter,
        });
        response.on('end', () => {
            statusCallback(response._getStatusCode());
            jsonCallback(response._getJSONData());
            res();
        });
        this.provisionerRouter.handle(request, response, (err) => {
            if (err) {
                // Errors thrown from the provisioner are in the form of [err, request]
                rej(err[0]);
            }
        });
    })
}

// Simulate a request to the link provisioning API
//  reqBody {object} - the API request body
//  statusCallback {function} - Called when the server returns a HTTP response code.
//  jsonCallback {function} - Called when the server returns a JSON object.
//  link {boolean} - true if this is a link request (false if unlink).
MockAppService.prototype._link = function(reqBody, statusCallback, jsonCallback) {
    return this._mockApiCall({
        method: 'POST',
        url: '/link',
        body: reqBody,
    }, statusCallback, jsonCallback);
}

MockAppService.prototype._unlink = function(reqBody, statusCallback, jsonCallback) {
    return this._mockApiCall({
        method: 'POST',
        url: '/link',
        body: reqBody,
    }, statusCallback, jsonCallback);
}

// Simulate a request to get provisioned mappings
//  reqParameters {object} - the API request parameters
//  statusCallback {function} - Called when the server returns a HTTP response code.
//  jsonCallback {function} - Called when the server returns a JSON object.
MockAppService.prototype._listLinks = function(reqParameters, statusCallback, jsonCallback) {
    return this._mockApiCall({
        method: 'GET',
        url: '/listlinks',
        params: reqParameters,
    }, statusCallback, jsonCallback);
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
