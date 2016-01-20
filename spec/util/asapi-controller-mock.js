/*
 * Mock replacement for AsapiController
 */
"use strict";
var Promise = require("bluebird");

/**
 * Construct a new mock ASAPI controller.
 * @return {AsapiController} A Mock ASAPI controller.
 */
module.exports.create = function() {
    var onFunctions = {
        // event type: [fn, fn]
    };
    var resolvers = {
        // user|alias : fn
    };

    var asapiCtrl = {
        setUserQueryResolver: jasmine.createSpy("setUserQueryResolver(fn)"),
        setAliasQueryResolver: jasmine.createSpy("setAliasQueryResolver(fn)"),
        addRegexPattern: jasmine.createSpy("addRegexPattern(type, regex, excl)"),
        getRegexNamespaces: jasmine.createSpy("getRegexNamespaces()"),
        setHomeserverToken: jasmine.createSpy("setHomeserverToken(tok)"),
        setLogger: function() {},
        on: jasmine.createSpy("AsapiCtrl.on(eventType, fn)"),
        _trigger: function(eventType, content) {
            var promises = [];
            if (onFunctions[eventType]) {
                for (var i = 0; i < onFunctions[eventType].length; i++) {
                    promises.push(onFunctions[eventType][i](content));
                }
            }
            if (promises.length === 1) {
                return promises[0];
            }
            return Promise.all(promises);
        },
        _queryAlias: function(alias) {
            return resolvers.alias(alias);
        },
        _queryUser: function(user) {
            return resolvers.user(user);
        }
    };
    asapiCtrl.on.andCallFake(function(eventType, fn) {
        if (!onFunctions[eventType]) {
            onFunctions[eventType] = [];
        }
        onFunctions[eventType].push(fn);
    });
    asapiCtrl.setAliasQueryResolver.andCallFake(function(fn) {
        resolvers.alias = fn;
    });
    asapiCtrl.setUserQueryResolver.andCallFake(function(fn) {
        resolvers.user = fn;
    });
    return asapiCtrl;
};
