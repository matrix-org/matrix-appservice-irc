/*
 * Mock replacement for 'irc'.
 */
"use strict";
var generatedClients = {};

function Client(addr, nick, opts) {
    generatedClients[addr+nick] = this;
    console.log("GC: %s",Object.keys(generatedClients));
    this.addListener = jasmine.createSpy("Client.addListener(event, fn)");
    this.connect = jasmine.createSpy("Client.connect(fn)");
    this.whois = jasmine.createSpy("Client.whois(nick, fn)");
    this.join = jasmine.createSpy("Client.join(channel, fn)");
    this.action = jasmine.createSpy("Client.action(channel, text)");
    this.ctcp = jasmine.createSpy("Client.ctcp(channel, kind, text)");
    this.say = jasmine.createSpy("Client.say(channel, text)");
};

module.exports.Client = Client;

// ===== helpers


module.exports._find = function(addr, nick) {
    return generatedClients[addr+nick];
};

module.exports._reset = function() {
    generatedClients = {};
};