/*
 * Mock replacement for AsapiController
 */
"use strict";

module.exports.create = function() {
    var onFunctions = {
        // event type: [fn, fn]
    };
    var resolvers = {
        // user|alias : fn
    };

    var asapiCtrl = {
        setUserQueryResolver: jasmine.createSpy("AsapiCtrl.setUserQueryResolver(fn)"),
        setAliasQueryResolver: jasmine.createSpy("AsapiCtrl.setAliasQueryResolver(fn)"),
        addRegexPattern: jasmine.createSpy("AsapiCtrl.addRegexPattern(type, regex, exclusive)"),
        getRegexNamespaces: jasmine.createSpy("AsapiCtrl.getRegexNamespaces()"),
        setHomeserverToken: jasmine.createSpy("AsapiCtrl.setHomeserverToken(tok)"),
        setLogger: function(){},
        on: jasmine.createSpy("AsapiCtrl.on(eventType, fn)"),
        _trigger: function(eventType, content) {
            if (onFunctions[eventType]) {
                for (var i=0; i<onFunctions[eventType].length; i++) {
                    onFunctions[eventType][i](content);
                }
            }
        },
        _query_alias: function(alias) {
            return resolvers.alias(alias);
        },
        _query_user: function(user) {
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