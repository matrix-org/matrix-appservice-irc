/*
 * This module contains all the logic to determine how incoming events from
 * IRC clients are mapped to events which are passed to the bridge.
 *
 * For example, every connected IRC client will get messages down their TCP
 * stream, but only 1 client should pass this through to the bridge to
 * avoid duplicates. This is typically handled by the MatrixBridge which is a
 * bot whose job it is to be the unique entity to have responsibility for passing
 * these events through to the bridge.
 *
 * However, we support disabling the bridge entirely which means one of the many
 * TCP streams needs to be responsible for passing the message to the bridge.
 * This is done using the following algorithm:
 *   - Create a hash "H" of (prefix, command, command-parameters) (aka the line)
 *   - Does H exist in the "processed" list?
 *      * YES: Was it you who processed H before?
 *          * YES: Process it again (someone sent the same message twice).
 *          *  NO: Ignore this message. (someone else has processed this)
 *      *  NO: Add H to the "processed" list with your client associated with it
 *             (this works without racing because javascript is single-threaded)
 *             and pass the message to the bridge for processing.
 * There are problems with this approach:
 *   - Unbounded memory consumption on the "processed" list.
 *   - Clients who previously "owned" messages disconnecting and not handling
 *     a duplicate messsage.
 * These are fixed by:
 *   - Periodically culling the "processed" list after a time T.
 *   - Checking if the client who claimed a message still has an active TCP
 *     connection to the server. If they do not have an active connection, the
 *     message hash can be "stolen" by another client.
 *
 * Rationale
 * ---------
 * In an ideal world, we'd have unique IDs on each message and it'd be first come,
 * first serve to claim an incoming message, but IRC doesn't "do" unique IDs.
 *
 * As a result, we need to handle the case where we get a message down that looks
 * exactly like one that was previously handled. Handling this across clients is
 * impossible (every message comes down like this, appearing as dupes). Handling
 * this *within* a client is possible; the *SAME* client which handled the prev
 * message knows that this isn't a dupe because dupes aren't sent down the same
 * TCP connection.
 *
 * Handling messages like this is risky though. We don't know for sure if the
 * client that handled the prev message will handle this new message. Therefore,
 * we check if the client who did the prev message is "dead" (inactive TCP conn),
 * and then "steal" ownership of that message if it is dead (again, this is
 * thread-safe provided the check and steal is done on a single turn of the event
 * loop). Even this isn't perfect though, as the connection may die without us
 * being aware of it (before TCP/app timeouts kick in), so we want to avoid having
 * to rely on stealing messages.
 *
 * We use a hashing algorithm mainly to reduce the key length per message
 * (which would otherwise be max 510 bytes). The strength of the hash (randomness)
 * determines the reliability of the bridge because it determines the rate of
 * "stealing" that is performed. At the moment, a max key size of 510 bytes is
 * acceptable with our expected rate of messages, so we're using the identity
 * function as our hash algorithm.
 *
 * Determining when to remove these keys from the processed dict is Hard. We can't
 * just mark it off when "all clients" get the message because all clients MAY NOT
 * always get the message e.g. due to a disconnect (leading to dead keys which
 * are never collected). Timeouts are reasonable but they need to be > TCP level
 * MSL (worse case) assuming the IRCd in question doesn't store-and-forward. The
 * MSL is typically 2 minutes, so a collection interval of 10 minutes is long
 * enough.
 */

"use strict";
var IrcAction = require("../models/IrcAction");
var IrcUser = require("../models/IrcUser");
var BridgeRequest = require("../models/BridgeRequest");
var log = require("../logging").get("IrcEventBroker");

const CLEANUP_TIME_MS = 1000 * 60 * 10; // 10min

function ProcessedDict() {
    this.processed = {
    // server.domain: {
    //   hash: {
    //     nick: <nick>,
    //     ts: <time claimed>
    // }
    };
    this.timeoutObj = null;
}
ProcessedDict.prototype.getClaimer = function(domain, hash) {
    if (!this.processed[domain] || !this.processed[domain][hash]) {
        return null;
    }
    return this.processed[domain][hash].nick;
};
ProcessedDict.prototype.claim = function(domain, hash, nick, cmd) {
    if (!this.processed[domain]) {
        this.processed[domain] = {};
    }
    this.processed[domain][hash] = {
        nick: nick,
        // we don't ever want to purge NAMES events
        ts: cmd === "names" ? null : Date.now()
    };
};

ProcessedDict.prototype.startCleaner = function() {
    var self = this;
    var expiredList = {
        // domain: [hash, hash, hash]
    };
    this.timeoutObj = setTimeout(function() {
        var now = Date.now();
        // loop the processed list looking for entries older than CLEANUP_TIME_MS
        Object.keys(self.processed).forEach(function(domain) {
            var entries = self.processed[domain];
            if (!entries) { return; }
            Object.keys(entries).forEach(function(hash) {
                var entry = entries[hash];
                if (entry.ts && (entry.ts + CLEANUP_TIME_MS) < now) {
                    if (!expiredList[domain]) {
                        expiredList[domain] = [];
                    }
                    expiredList[domain].push(hash);
                }
            });
        });
        // purge the entries
        Object.keys(expiredList).forEach(function(domain) {
            var hashes = expiredList[domain];
            log.debug("Cleaning up %s entries from %s", hashes.length, domain);
            hashes.forEach(function(hash) {
                delete self.processed[domain][hash];
            });
        });

        self.startCleaner();
    }, CLEANUP_TIME_MS);
};

function IrcEventBroker(bridge, clientPool, ircHandler) {
    this._processed = new ProcessedDict();
    this._processed.startCleaner();
    this._pool = clientPool;
    this._appServiceBridge = bridge;
    this._ircHandler = ircHandler;
}

// debugging: util.inspect() override
IrcEventBroker.prototype.inspect = function(depth) {
    return this._processed.processed;
};

/*
 * Attempt to claim this message as this client
 * @return {boolean} True if you successfully claimed it.
 */
IrcEventBroker.prototype._attemptClaim = function(client, msg) {
    var domain = client.server.domain;
    if (!msg.prefix || !msg.rawCommand || !msg.args) {
        log.warn("Unexpected msg format: %s", JSON.stringify(msg));
        return false; // drop them for now.
    }
    var hash = msg.prefix + msg.rawCommand + msg.args.join("");
    var handledByNick = this._processed.getClaimer(domain, hash);
    // we claim it if no one else has or if we previously did this hash.
    var shouldClaim = (
        handledByNick === null || handledByNick === client.nick
    );
    if (shouldClaim) {
        log.debug("%s is claiming a hash for cmd %s", client.nick, msg.rawCommand);
        this._processed.claim(domain, hash, client.nick, msg.rawCommand);
        return true;
    }
    else if (handledByNick) {
        // someone else has allegedly claimed this; see if we can steal it.
        var owner = this._pool.getBridgedClientByNick(client.server, handledByNick);
        if (!owner) {
            // finders keepers
            log.debug(
                "%s is stealing hash %s from %s because they are dead",
                client.nick, hash, handledByNick
            );
            this._processed.claim(domain, hash, client.nick, msg.rawCommand);
            return true;
        }
    }
    return false;
};

IrcEventBroker.prototype._hookIfClaimed = function(client, connInst, eventName, fn) {
    if (client.isBot && !client.server.isBotEnabled()) {
        return; // don't both attaching listeners we'll never invoke.
    }
    var self = this;

    connInst.addListener(eventName, function() {
        if (client.server.isBotEnabled() && client.isBot) {
            // the bot handles all the things! Just proxy straight through.
            fn.apply(self, arguments);
        }
        else if (!client.server.isBotEnabled() && !client.isBot) {
            // this works because the last arg in all the callbacks are the
            // raw msg object (default to empty obj just in case)
            var msg = arguments[arguments.length - 1] || {};
            if (eventName === "names") {
                /*
                 * NAMES is special and doesn't abide by this (multi lines per
                 * event), and we don't want to process all these names each time
                 * a client joins a channel(!) so we need to get a unique msg
                 * for the channel only (not users). This is why we skip the names
                 * object attached to the args in the msg.
                 *
                 * We also do not purge NAMES msgs from the processed hash list
                 * to avoid repeatedly joining IRC lists to Matrix. This isn't
                 * perfect: if every connected client died and the list changed,
                 * we wouldn't sync it - but this should be good enough.
                 */
                var chan = arguments[0];
                msg = {
                    prefix: "server_sent",
                    rawCommand: "names",
                    args: [chan]
                };
            }

            if (self._attemptClaim(client, msg)) {
                // We're responsible for passing this message to the bridge.
                fn.apply(self, arguments);
            }
        }
    });
};

IrcEventBroker.prototype.sendMetadata = function(client, msg) {
    if (client.isBot || !client.server.shouldSendConnectionNotices()) {
        return;
    }
    var req = new BridgeRequest(
        this._appServiceBridge.getRequestFactory().newRequest({
            data: {
                isFromIrc: true
            }
        })
    );
    complete(req, this._ircHandler.onMetadata(req, client, msg));
};

IrcEventBroker.prototype.addHooks = function(client, connInst) {
    var server = client.server;
    var ircHandler = this._ircHandler;

    var createUser = (nick) => {
        return new IrcUser(
            server, nick,
            this._pool.getBridgedClientByNick(server, nick) !== undefined
        );
    };

    var createRequest = () => {
        return new BridgeRequest(
            this._appServiceBridge.getRequestFactory().newRequest({
                data: {
                    isFromIrc: true
                }
            })
        );
    };

    // === Attach client listeners ===
    // We want to listen for PMs for individual clients regardless of whether the
    // bot is enabled or disabled, as only they will receive the event. We don't
    // currently handle any PMs directed at the bot itself (e.g. for admin stuff)
    // but we could in the future (abusing the fact that the BridgedClient
    // connection is still made to the IRCd)
    if (!client.isBot) {
        // listen for PMs for clients. If you listen for rooms, you'll get
        // duplicates since the bot will also invoke the callback fn!
        connInst.addListener("message", function(from, to, text) {
            if (to.indexOf("#") === 0) { return; }
            var req = createRequest();
            complete(req, ircHandler.onPrivateMessage(
                req,
                server, createUser(from), createUser(to),
                new IrcAction("message", text)
            ));
        });
        connInst.addListener("notice", function(from, to, text) {
            if (!from || to.indexOf("#") === 0) { return; }
            var req = createRequest();
            complete(req, ircHandler.onPrivateMessage(
                req,
                server, createUser(from), createUser(to),
                new IrcAction("notice", text)
            ));
        });
        connInst.addListener("ctcp-privmsg", function(from, to, text) {
            if (to.indexOf("#") === 0) { return; }
            if (text.indexOf("ACTION ") === 0) {
                var req = createRequest();
                complete(req, ircHandler.onPrivateMessage(
                    req,
                    server, createUser(from), createUser(to),
                    new IrcAction("emote", text.substring("ACTION ".length))
                ));
            }
        });
    }

    // Listen for other events

    this._hookIfClaimed(client, connInst, "part", function(chan, nick, reason, msg) {
        var req = createRequest();
        complete(req, ircHandler.onPart(
            req, server, createUser(nick), chan, "part"
        ));
    });
    this._hookIfClaimed(client, connInst, "quit", function(nick, reason, chans, msg) {
        chans = chans || [];
        chans.forEach(function(chan) {
            var req = createRequest();
            complete(req, ircHandler.onPart(
                req, server, createUser(nick), chan, "quit"
            ));
        });
    });
    this._hookIfClaimed(client, connInst, "kick", function(chan, nick, by, reason, msg) {
        var req = createRequest();
        complete(req, ircHandler.onKick(
            req, server, createUser(by), createUser(nick), chan, reason
        ));
    });
    this._hookIfClaimed(client, connInst, "join", function(chan, nick, msg) {
        var req = createRequest();
        complete(req, ircHandler.onJoin(
            req, server, createUser(nick), chan, "join"
        ));
    });
    // bucket names and drain them one at a time to avoid flooding
    // the matrix side with registrations / joins
    var namesBucket = [
    //  { chan: <channel>, nick: <nick> }
    ];
    var processingBucket = false;
    var popName = function() {
        var name = namesBucket.pop(); // LIFO but who cares
        if (!name) {
            processingBucket = false;
            return null;
        }
        client.log.debug(
            "Pop %s/%s from names bucket (%s remaining)",
            name.nick, name.chan, namesBucket.length
        );
        var req = createRequest();
        return complete(req, ircHandler.onJoin(
            req, server, createUser(name.nick), name.chan, "names"
        ));
    };
    var purgeNames = function() {
        var promise = popName();
        if (promise) {
            promise.finally(function() {
                purgeNames();
            });
        }
    };

    this._hookIfClaimed(client, connInst, "names", function(chan, names) {
        if (names) {
            var userlist = Object.keys(names);
            userlist.forEach(function(nick) {
                namesBucket.push({
                    chan: chan,
                    nick: nick
                });
                // var opsLevel = names[nick]; // + @ or empty string
                // TODO do something with opsLevel
            });
            client.log.info(
                "NAMEs: Adding %s nicks from %s.", userlist.length, chan
            );
            client.log.debug("Names bucket has %s entries", namesBucket.length);
            if (!processingBucket) {
                processingBucket = true;
                purgeNames();
            }
        }
    });
    // listen for mode changes
    this._hookIfClaimed(client, connInst, "+mode", function(channel, by, mode, arg) {
        var req = createRequest();
        complete(req, ircHandler.onMode(
            req, server, channel, by, mode, true, arg
        ));
    });
    this._hookIfClaimed(client, connInst, "-mode", function(channel, by, mode, arg) {
        var req = createRequest();
        complete(req, ircHandler.onMode(
            req, server, channel, by, mode, false, arg
        ));
    });
    this._hookIfClaimed(client, connInst, "message", function(from, to, text) {
        if (to.indexOf("#") !== 0) { return; }
        var req = createRequest();
        complete(req, ircHandler.onMessage(
            req, server, createUser(from), to,
            new IrcAction("message", text)
        ));
    });
    this._hookIfClaimed(client, connInst, "ctcp-privmsg", function(from, to, text) {
        if (to.indexOf("#") !== 0) { return; }
        if (text.indexOf("ACTION ") === 0) {
            var req = createRequest();
            complete(req, ircHandler.onMessage(
                req, server, createUser(from), to,
                new IrcAction("emote", text.substring("ACTION ".length))
            ));
        }
    });
    this._hookIfClaimed(client, connInst, "notice", function(from, to, text) {
        if (to.indexOf("#") !== 0) { return; }
        if (from) { // ignore server notices
            var req = createRequest();
            complete(req, ircHandler.onMessage(
                req, server, createUser(from), to, new IrcAction("notice", text)
            ));
        }
    });
    this._hookIfClaimed(client, connInst, "topic", function(channel, topic, nick) {
        if (channel.indexOf("#") !== 0) { return; }

        if (nick && nick.indexOf("@") !== -1) {
            var match = nick.match(
                // https://github.com/martynsmith/node-irc/blob/master/lib/parse_message.js#L26
                /^([_a-zA-Z0-9\[\]\\`^{}|-]*)(!([^@]+)@(.*))?$/
            );
            if (match) {
                nick = match[1];
            }
        }
        var req = createRequest();
        complete(req, ircHandler.onMessage(
            req, server, createUser(nick), channel, new IrcAction("topic", topic)
        ));
    });
};

function complete(req, promise) {
    return promise.then(function(res) {
        req.resolve(req);
    }, function(err) {
        req.reject(err);
    });
}

module.exports = IrcEventBroker;
