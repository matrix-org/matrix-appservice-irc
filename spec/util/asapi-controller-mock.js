/*
 * Mock replacement for AsapiController
 */
"use strict";

module.exports.create = function() {
    var onFunctions = {
        // event type: [fn, fn]
    };
    var asapiCtrl = {
        setUserQueryResolver: jasmine.createSpy("AsapiCtrl.setUserQueryResolver(fn)"),
        setAliasQueryResolver: jasmine.createSpy("AsapiCtrl.setAliasQueryResolver(fn)"),
        addRegexPattern: jasmine.createSpy("AsapiCtrl.addRegexPattern(type, regex, exclusive)"),
        getRegexNamespaces: jasmine.createSpy("AsapiCtrl.getRegexNamespaces()"),
        setHomeserverToken: jasmine.createSpy("AsapiCtrl.setHomeserverToken(tok)"),
        on: jasmine.createSpy("AsapiCtrl.on(eventType, fn)"),
        _trigger: function(eventType, content) {
            if (onFunctions[eventType]) {
                for (var i=0; i<onFunctions[eventType].length; i++) {
                    onFunctions[eventType][i](content);
                }
            }
        },
    };
    asapiCtrl.on.andCallFake(function(eventType, fn) {
        if (!onFunctions[eventType]) {
            onFunctions[eventType] = [];
        }
        onFunctions[eventType].push(fn);
    });
    return asapiCtrl;
};