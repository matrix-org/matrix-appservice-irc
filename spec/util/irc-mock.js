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

    // invoke any waiting _findClientAsync calls
    var deferList = deferredsForClients[addr+"_"+nick];
    var that = this;
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