/*
 * Mock replacement for 'irc'.
 */
"use strict";
var Promise = require("bluebird");
var util = require("util");
var EventEmitter = require('events').EventEmitter;

var instanceEmitter, clientEmitter;
var DELIM = "_DELIM_";
var instances = {
    // addr +"_DELIM_" + nick : Client
};

function getClient(addr, nick) {
    return instances[addr + DELIM + nick];
}
function setClient(client, addr, nick) {
    // if we're clobbering a client, mark the clobbered client
    // as dead so emitted events don't fire.
    if (instances[addr + DELIM + nick]) {
        instances[addr + DELIM + nick]._dead = true;
    }
    instances[addr + DELIM + nick] = client;
    instanceEmitter.emit("client_" + addr + "_" + nick, client);
}
function setClientNick(addr, oldNick, newNick) {
    var client = instances[addr + DELIM + oldNick];
    client.nick = newNick;
    instances[addr + DELIM + newNick] = client;
    instances[addr + DELIM + oldNick] = null;
    instanceEmitter.emit("client_" + addr + "_" + newNick, client);
}

/**
 * Reset all mock IRC clients.
 */
module.exports._reset = function() {
    Object.keys(instances).forEach(function(k) {
        var cli = instances[k];
        if (cli) {
            cli._dead = true;
        }
    });
    instances = {};
    // emitter when clients are added
    instanceEmitter = new EventEmitter();
    // emitter when functions are called on a client.
    clientEmitter = new EventEmitter();
};

function Client(addr, nick, opts) {
    // store this instance so tests can grab it and manipulate it.
    var self = this;
    this.addr = addr;
    this.nick = nick;
    this.opts = opts;
    this.chans = {};

    var spies = [
        "connect", "whois", "join", "send", "action", "ctcp", "say",
        "disconnect", "notice", "part", "names", "mode"
    ];
    spies.forEach(function(fnName) {
        self[fnName] = jasmine.createSpy("Client." + fnName);
        self[fnName].and.callFake(function() {
            if (self._dead) { return; }
            // emit that the action was performed along with the args. This can
            // be caught in the form:
            // clientEmitter.on(addr+"_"+nick,
            // function(fnName, client, arg1, arg2 ...)) {
            //     // stuff
            // }
            var args = [self.addr + "_" + self.nick, fnName, self];
            for (var i = 0; i < arguments.length; i++) {
                args.push(arguments[i]);
            }
            console.log(
                "TEST: Bridge called IRC client.%s(%s)",
                fnName, JSON.stringify(args).substring(0, 40)
            );
            clientEmitter.emit.apply(clientEmitter, args);
        });
    });

    this.disconnect = jasmine.createSpy("Client.disconnect");

    this.disconnect.and.callFake(function (msg, cb) {
        var args = [self.addr + "_" + self.nick, 'disconnect', self];
        for (var i = 0; i < arguments.length; i++) {
            args.push(arguments[i]);
        }
        console.log(
            "TEST: Bridge called IRC client.disconnect(%s)",
            JSON.stringify(args).substring(0, 40)
        );
        clientEmitter.emit.apply(clientEmitter, args);

        // Auto callback for all disconnect calls
        cb();
    });

    this._changeNick = function(oldNick, newNick) {
        setClientNick(self.addr, oldNick, newNick);
        // emit the nick message from the server
        process.nextTick(function() {
            // send a response from the IRC server
            self.emit("nick", oldNick, newNick);
        });
    };

    this._invokeCallback = function(cb) {
        return new Promise(function(resolve, reject) {
            process.nextTick(function() {
                if (cb) {
                    cb();
                }
                resolve();
            });
        });
    };

    this._toLowerCase = function(channel) {
        return channel.toLowerCase();
    }

    this.modeForPrefix = {
        "@" : "o",
        "+" : "v",
    }

    this.chanData = function(channel) {
        return this.chans[channel];
    }

    // Copied over from irc.js and modified slightly
    this.getSplitMessages = function(target, text) {
        // hostmask length is probably about 3 * nick length
        var maxLength = 497 - 4 * this.nick.length - target.length;
        if (text) {
            return text.toString().split(/\r?\n/).filter(function(line) {
                return line.length > 0;
            }).map(function(line) {
                return self._splitLongLines(line, maxLength, []);
            }).reduce(function(a, b) {
                return a.concat(b);
            }, []);
        }
        return [];
    };

    // Copied over from irc.js
    this._splitLongLines = function(words, maxLength, destination) {
        if (words.length == 0) {
            return destination;
        }
        if (words.length <= maxLength) {
            destination.push(words);
            return destination;
        }
        var c = words[maxLength];
        var cutPos;
        var wsLength = 1;
        if (c.match(/\s/)) {
            cutPos = maxLength;
        } else {
            var offset = 1;
            while ((maxLength - offset) > 0) {
                var c = words[maxLength - offset];
                if (c.match(/\s/)) {
                    cutPos = maxLength - offset;
                    break;
                }
                offset++;
            }
            if (maxLength - offset <= 0) {
                cutPos = maxLength;
                wsLength = 0;
            }
        }
        var part = words.substring(0, cutPos);
        destination.push(part);
        return this._splitLongLines(words.substring(cutPos + wsLength, words.length), maxLength, destination);
    };

    setClient(self, addr, nick);
}
util.inherits(Client, EventEmitter);

/**
 * A mock IRC Client class.
 */
module.exports.Client = Client;

/**
 * Get an IRC client with the given domain and nick when the AS makes one.
 * @param {String} addr : The IRC server address.
 * @param {String} nick : The IRC nick to obtain a client for.
 * @return {Promise} Which is resolved with the IRC {@link Client} instance.
 */
module.exports._findClientAsync = function(addr, nick) {
    var client = getClient(addr, nick);
    if (client) {
        return Promise.resolve(client);
    }

    return new Promise(function(resolve, reject) {
        instanceEmitter.once("client_" + addr + "_" + nick, function(cli) {
            resolve(cli);
        });
    });
};

/**
 * Invoke a function when the AS invokes a function on the mock IRC client.
 * @param {String} addr : The IRC server address for the client.
 * @param {String} nick : The IRC nick for the client.
 * @param {String} fnName : The function name that the AS will invoke.
 * @param {Function} invokeFn : The function to invoke. The first parameter will
 * be the {@link Client} with the remaining parameters being the parameters the
 * AS invoked the original function with.
 */
module.exports._whenClient = function(addr, nick, fnName, invokeFn) {
    console.log("TEST: Test listening for %s to call function '%s'", (addr + "_" + nick), fnName);
    clientEmitter.on((addr + "_" + nick), function(invokedFnName, client) {
        if (invokedFnName !== fnName) {
            return;
        }
        // invoke function with the remaining args (incl. Client object)
        var args = [];
        for (var i = 1; i < arguments.length; i++) {
            args.push(arguments[i]);
        }

        // Remove the retry count, which was added during the implementation of
        //  Scheduler. The node-irc library accepts a retryCount optionally as
        //  the first argument. This is given as 1 in ConnectionInstance.connect
        if (invokedFnName === "connect") {
            args.splice(1, 1);
        }

        console.log(
            "TEST: Invoking test callback for user %s : client.%s(%s)",
            (addr + "_" + nick), invokedFnName, JSON.stringify(args).substring(0, 40)
        );

        invokeFn.apply(client, args);
    });
};

/**
 * Automatically join IRC channels for a given IRC client.
 * @param {String} addr : The IRC server address for the client.
 * @param {String} nick : The IRC nick for the client.
 * @param {String|Array} channels : The list of channels to automatically join.
 */
module.exports._autoJoinChannels = function(addr, nick, channels) {
    if (typeof channels === "string") {
        channels = [channels];
    }
    module.exports._whenClient(addr, nick, "join", function(client, chan, cb) {
        if (channels.indexOf(chan) != -1) {
            client.chans[chan] = {};
            client._invokeCallback(cb);
        }
    });
};

/**
 * Automatically join IRC networks for a given IRC client.
 * @param {String} addr : The IRC server address for the client.
 * @param {String} nick : The IRC nick for the client.
 * @param {String|Array} networks : The list of networks to automatically join.
 */
module.exports._autoConnectNetworks = function(addr, nick, networks) {
    if (typeof networks === "string") {
        networks = [networks];
    }
    module.exports._whenClient(addr, nick, "connect", function(client, cb) {
        if (networks.indexOf(client.addr) != -1) {
            client._invokeCallback(cb);
        }
    });
};
