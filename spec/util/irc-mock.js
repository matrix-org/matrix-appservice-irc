/*
 * Mock replacement for 'irc'.
 */
"use strict";
var generatedClients = {};

function Client(addr, nick, opts) {
    generatedClients[addr+nick] = this;
};
Client.prototype = {
    addListener: jasmine.createSpy("Client.addListener(event, fn)"),
    connect: jasmine.createSpy("Client.connect(fn)"),
    whois: jasmine.createSpy("Client.whois(nick, fn)"),
    join: jasmine.createSpy("Client.join(channel, fn)"),
    action: jasmine.createSpy("Client.action(channel, text)"),
    ctcp: jasmine.createSpy("Client.ctcp(channel, kind, text)"),
    say: jasmine.createSpy("Client.say(channel, text)")
};

module.exports.Client = Client;

// ===== helpers


module.exports._find = function(addr, nick) {
    return generatedClients[addr+nick];
};