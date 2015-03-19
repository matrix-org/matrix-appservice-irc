/*
 * Mock replacement for AsapiController
 */
"use strict";

module.exports.create = function() {
    return  {
        setUserQueryResolver: jasmine.createSpy("AsapiCtrl.setUserQueryResolver(fn)"),
        setAliasQueryResolver: jasmine.createSpy("AsapiCtrl.setAliasQueryResolver(fn)"),
        addRegexPattern: jasmine.createSpy("AsapiCtrl.addRegexPattern(type, regex, exclusive)"),
        getRegexNamespaces: jasmine.createSpy("AsapiCtrl.getRegexNamespaces()"),
        setHomeserverToken: jasmine.createSpy("AsapiCtrl.setHomeserverToken(tok)"),
        on: jasmine.createSpy("AsapiCtrl.on(eventType, fn)")
    };
};