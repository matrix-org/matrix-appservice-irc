/*
 * Mock replacement for 'irc'.
 */
"use strict";
var q = require("q");
var generatedClients = {
    // addr: {
    //    nick: Client
    // }
};
var deferredsForClients = {
    // addr_nick: [Deferred, ...]
};

function Client(addr, nick, opts) {
    // store this instance so tests can grab it and manipulate it.
    if (!generatedClients[addr]) {
        generatedClients[addr] = {};
    }
    generatedClients[addr][nick] = this;

    this.addListener = jasmine.createSpy("Client.addListener(event, fn)");
    this.connect = jasmine.createSpy("Client.connect(fn)");
    this.whois = jasmine.createSpy("Client.whois(nick, fn)");
    this.join = jasmine.createSpy("Client.join(channel, fn)");
    this.action = jasmine.createSpy("Client.action(channel, text)");
    this.ctcp = jasmine.createSpy("Client.ctcp(channel, kind, text)");
    this.say = jasmine.createSpy("Client.say(channel, text)");

    // wrap the spies so they can be used as Deferreds. This allows tests to do
    // things like client._triggerConnect().then(...) which will be resolved
    // whenever the service calls the connect() function or immediately
    // if the service already called connect. This means we don't need to wait
    // for a random amount of time before checking if the call was invoked. In
    // the event that connect() is NOT called, the 'done' timer in the test will
    // fire after 5s (thanks Jasmine!).
    var initInvocationStruct = function(spy, key) {
        // for a given spy function, create a struct which will store the
        // service's callbacks and invoke them,
        // grouped on a key (which may be a concatenation of args).
        if (!spy._invocations) {
            spy._invocations = {}
        }
        if (!spy._invocations[key]) {
            spy._invocations[key] = {
                callbacks: [],
                defer: undefined
            }
        }
    };
    var storeCallbackAndMaybeInvoke = function(obj, methodName, key, fn) {
        var spy = obj[methodName];
        // if there is a deferred on this spy waiting, resolve it after calling
        // fn, else add this as a call.
        if (!spy._invocations || !spy._invocations[key]) {
            initInvocationStruct(spy, key);
        }
        
        if (spy._invocations[key].defer) {
            // a test is waiting on this to be called, so call it and resolve
            fn();
            spy._invocations[key].defer.resolve(obj);
        }
        else {
            spy._invocations[key].callbacks.push(fn);
        }
    };
    var that = this;
    this.connect.andCallFake(function(fn) {
        storeCallbackAndMaybeInvoke(that, "connect", "_", fn);
    });
    this.join.andCallFake(function(channel, fn) {
        storeCallbackAndMaybeInvoke(that, "join", channel, fn);
    });
    
    var trigger = function(obj, methodName, key) {
        // if there is already a call to methodName, invoke their 'fn's and 
        // return a resolved defer.
        // else add a deferred on this methodName for the fake call to resolve.
        var spy = obj[methodName];
        if (!spy._invocations || !spy._invocations[key]) {
            initInvocationStruct(spy, key);
        }
        if (spy._invocations[key].callbacks.length > 0) { // already called
            spy._invocations[key].callbacks.forEach(function(fn) {
                fn();
            });
            spy._invocations[key].callbacks = [];
            return q(obj);
        }
        else {
            spy._invocations[key].defer = q.defer();
            return spy._invocations[key].defer.promise;
        }
    };
    this._triggerConnect = function() {
        return trigger(that, "connect", "_");
    };
    this._triggerJoinFor = function(channel) {
        return trigger(that, "join", channel);
    };

    // invoke any waiting _findClientAsync calls
    var deferList = deferredsForClients[addr+"_"+nick];
    if (deferList) {
        deferList.forEach(function(defer) {
            defer.resolve(that);
        });
    }
};

module.exports.Client = Client;

// ===== helpers

module.exports._findClientAsync = function(addr, nick) {
    var client = module.exports._findClient(addr, nick);
    if (client) {
        return q(client);
    }
    var key = addr+"_"+nick;
    if (!deferredsForClients[key]) {
        deferredsForClients[key] = [];
    }
    var d = q.defer();
    deferredsForClients[key].push(d);
    return d.promise;
};

module.exports._findClient = function(addr, nick) {
    if (!generatedClients[addr]) {
        return;
    }
    return generatedClients[addr][nick];
};

module.exports._reset = function() {
    generatedClients = {};
};