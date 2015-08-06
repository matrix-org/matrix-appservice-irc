"use strict";

var q = require("q");
var util = require("util");
var EventEmitter = require("events").EventEmitter;
var ident = require("./ident");
var pool = require("./client-pool");
var actions = require("../models/actions");
var clientConnection = require("./client-connection");
var names = require("./names");
var IrcRoom = require("../models/rooms").IrcRoom;
var IrcUser = require("../models/users").IrcUser;
var log = require("../logging").get("irc-client");

// The length of time to wait before trying to join the channel again
var JOIN_TIMEOUT_MS = 15 * 1000; // 15s

/**
 * Create a new bridged IRC client.
 * @constructor
 * @param {Object} ircUser : The IRC user to create a connection for.
 * @param {Object} matrixUser : Optional. The matrix user this virtual IRC user.
 * @param {boolean} isBot : True if this is the bot
 */
function BridgedClient(ircUser, matrixUser, isBot) {
    this.matrixUser = matrixUser;
    this.setIrcUserInfo(ircUser);

    this.isBot = Boolean(isBot);
    this.lastActionTs = Date.now();
    this.inst = null;
    this.instCreationFailed = false;
    this.explicitDisconnect = false;
    this.chanList = [];
    this._connectDefer = q.defer();
    this._id = (Math.random() * 1e20).toString(36);
    // decorate log lines with the nick and domain, along with an instance id
    var prefix = "<" + this.nick + "@" + this.server.domain + "#" + this._id + "> ";
    if (this.userId) {
        prefix += "(" + this.userId + ") ";
    }
    this.log = {
        debug: function() {
            arguments[0] = prefix + arguments[0];
            log.debug.apply(log, arguments);
        },
        info: function() {
            arguments[0] = prefix + arguments[0];
            log.info.apply(log, arguments);
        },
        error: function() {
            arguments[0] = prefix + arguments[0];
            log.error.apply(log, arguments);
        }
    };
}
util.inherits(BridgedClient, EventEmitter);

BridgedClient.prototype.setIrcUserInfo = function(ircUser) {
    this.ircUser = ircUser;
    this.server = ircUser.server;
    this.nick = ircUser.nick;
    this.password = ircUser.password;
    this.userId = this.matrixUser ? this.matrixUser.userId : ircUser.username;
};

BridgedClient.prototype.isDead = function() {
    if (this.instCreationFailed || (this.inst && this.inst.dead)) {
        return true;
    }
    return false;
};

/**
 * @param {Object} callbacks
 * @return {ConnectionInstance} A new connected connection instance.
 */
BridgedClient.prototype.connect = function(callbacks) {
    this.callbacks = callbacks;
    var self = this;
    var server = this.server;
    var defer = q.defer();

    names.getIrcNames(this.ircUser, this.matrixUser).then(function(nameInfo) {
        self.log.info(
            "Connecting to IRC server %s as %s (user=%s)",
            server.domain, nameInfo.nick, nameInfo.username
        );

        return clientConnection.create(server, {
            nick: nameInfo.nick,
            username: nameInfo.username,
            realname: nameInfo.realname,
            password: self.password
        }, function(inst) {
            self._onConnectionCreated(inst, nameInfo, callbacks);
        });
    }).done(function(connInst) {
        self.inst = connInst;
        self.unsafeClient = connInst.client;
        self.log.debug("connected!");
        self.emit("client-connected", self);
        // we may have been assigned a different nick, so update it from source
        self.nick = connInst.client.nick;
        self._connectDefer.resolve();
        self._keepAlive();
        connInst.client.addListener("registered", function() {
            var oldNick = self.nick;
            if (oldNick !== self.unsafeClient.nick) {
                self.log.info(
                    "REGISTERED: Nick changed from '" + oldNick + "' to '" +
                    self.unsafeClient.nick + "'."
                );
                self.nick = self.unsafeClient.nick;
                self.emit("nick-change", self, oldNick, self.unsafeClient.nick);
            }
        });
        connInst.client.addListener("nick", function(old, newNick) {
            if (old === self.nick) {
                self.log.info(
                    "NICK: Nick changed from '" + old + "' to '" + newNick + "'."
                );
                self.nick = newNick;
                self.emit("nick-change", self, old, newNick);
            }
        });
        defer.resolve(connInst);
    }, function(e) {
        self.log.debug("Failed to connect.");
        self.instCreationFailed = true;
        defer.reject(e);
    });

    return defer.promise;
};

BridgedClient.prototype.disconnect = function(reason) {
    this.explicitDisconnect = true;
    if (!this.inst || this.inst.dead) {
        return q();
    }
    var d = q.defer();
    this.inst.disconnect(reason, function() {
        d.resolve();
    });
    return d.promise;
};

/**
 * Change this user's nick.
 * @param {string} newNick : The new nick for the user.
 * @return {Promise<String>} Which resolves to a message to be sent to the user.
 */
BridgedClient.prototype.changeNick = function(newNick) {
    // TODO: This is dupe logic with server.js
    // strip illegal chars according to RFC 1459 Sect 2.3.1
    // but allow _ because most IRC servers allow that.
    var nick = newNick.replace(/[^A-Za-z0-9\]\[\^\\\{\}\-`_]/g, "");
    // nicks must start with a letter
    if (!/^[A-Za-z]/.test(nick)) {
        return q.reject("Nick '" + nick + "' must start with a letter.");
    }
    var maxNickLen = 9; // RFC 1459 default
    if (this.unsafeClient.supported &&
            typeof this.unsafeClient.supported.nicklength == "number") {
        maxNickLen = this.unsafeClient.supported.nicklength;
    }
    if (nick.length > maxNickLen) {
        return q.reject("Nick '" + nick + "' is too long. (Max: " + maxNickLen + ")");
    }
    if (nick === this.nick) {
        return q("Your nick is already '" + nick + "'.");
    }

    var d = q.defer();
    this.unsafeClient.once("nick", function(old, n) {
        d.resolve("Nick changed from '" + old + "' to '" + n + "'.");
    });
    this.unsafeClient.send("NICK", nick);
    return d.promise;
};

BridgedClient.prototype.joinChannel = function(channel) {
    return joinChannel(this, channel);
};

BridgedClient.prototype.leaveChannel = function(channel) {
    if (!this.inst || this.inst.dead) {
        return q(); // we were never connected to the network.
    }
    if (Object.keys(this.unsafeClient.chans).indexOf(channel) === -1) {
        return q(); // we were never joined to it.
    }
    if (channel.indexOf("#") !== 0) {
        return q(); // PM room
    }
    var self = this;
    var defer = q.defer();
    this._removeChannel(channel);
    self.log.debug("Leaving channel %s", channel);
    this.unsafeClient.part(channel, "User left", function() {
        self.log.debug("Left channel %s", channel);
        defer.resolve();
    });

    return defer.promise;
};

BridgedClient.prototype.sendAction = function(room, action) {
    this._keepAlive();
    switch (action.action) {
        case "message":
            return sendMessage(this, room, "message", action.text);
        case "notice":
            return sendMessage(this, room, "notice", action.text);
        case "emote":
            return sendMessage(this, room, "action", action.text);
        case "topic":
            return setTopic(this, room, action.topic);
        default:
            this.log.error("Unknown action type: %s", action.action);
    }
    return q.reject("Unknown action type: %s", action.action);
};

BridgedClient.prototype.whois = function(nick) {
    var defer = q.defer();
    var self = this;
    this.unsafeClient.whois(nick, function(whois) {
        if (!whois.user) {
            defer.reject("Cannot find nick on whois.");
            return;
        }
        defer.resolve({
            server: self.server,
            nick: nick
        });
    });
    return defer.promise;
};

BridgedClient.prototype._keepAlive = function() {
    this.lastActionTs = Date.now();
    var idleTimeout = this.server.getIdleTimeoutMs();
    if (idleTimeout > 0) {
        if (this._idleTimeout) {
            // stop the timeout
            clearTimeout(this._idleTimeout);
        }
        this.log.debug(
            "_keepAlive; Restarting %ss idle timeout", idleTimeout
        );
        // restart the timeout
        var self = this;
        this._idleTimeout = setTimeout(function() {
            self.log.info("Idle timeout has expired");
            if (self.server.shouldSyncMembershipToIrc("initial")) {
                self.log.info(
                    "Not disconnecting because %s is mirroring matrix membership lists",
                    self.server.domain
                );
                return;
            }
            self.disconnect(
                "Idle timeout reached: " + idleTimeout + "s"
            ).done(function() {
                self.log.info("Idle timeout reached: Disconnected");
            }, function(e) {
                self.log.error("Error when disconnecting: %s", JSON.stringify(e));
            });
        }, (1000 * idleTimeout));
    }
};
BridgedClient.prototype._removeChannel = function(channel) {
    var i = this.chanList.indexOf(channel);
    if (i === -1) {
        return;
    }
    this.chanList.splice(i, 1);
};
BridgedClient.prototype._addChannel = function(channel) {
    var i = this.chanList.indexOf(channel);
    if (i !== -1) {
        return; // already added
    }
    this.chanList.push(channel);
};
BridgedClient.prototype.getLastActionTs = function() {
    return this.lastActionTs;
};
BridgedClient.prototype._onConnectionCreated = function(connInst, nameInfo, callbacks) {
    var self = this;
    var server = this.server;

    // listen for a connect event which is done when the TCP connection is
    // established and set ident info (this is different to the connect() callback
    // in node-irc which actually fires on a registered event..)
    connInst.client.once("connect", function() {
        var localPort = -1;
        if (connInst.client.conn && connInst.client.conn.localPort) {
            localPort = connInst.client.conn.localPort;
        }
        if (localPort > 0) {
            ident.setMapping(nameInfo.username, localPort);
        }
    });

    connInst.onDisconnect = function() {
        self.emit("client-disconnected", self);
    };

    var createUser = function(nick) {
        return new IrcUser(
            server, nick,
            pool.getBridgedClientByNick(server, nick)
        );
    };

    // === Attach bot listeners ===
    if (this.isBot) {
        // make the bot listen for join/parts
        connInst.addListener("part", function(chan, nick, reason, msg) {
            callbacks.onPart(server, createUser(nick), chan, "part");
        });
        connInst.addListener("quit", function(nick, reason, chans, msg) {
            chans = chans || [];
            chans.forEach(function(chan) {
                callbacks.onPart(server, createUser(nick), chan, "quit");
            });
        });
        connInst.addListener("kick", function(chan, nick, by, reason, msg) {
            callbacks.onPart(server, createUser(nick), chan, "kick");
        });
        connInst.addListener("join", function(chan, nick, msg) {
            callbacks.onJoin(server, createUser(nick), chan, "join");
        });
        // bucket names and drain them once per second to avoid flooding
        // the matrix side with registrations / joins
        var namesBucket = [
        //  { chan: <channel>, nick: <nick> }
        ];
        var processingBucket = false;
        var popName = function() {
            var name = namesBucket.pop(); // LIFO but who cares
            if (!name) {
                processingBucket = false;
                return;
            }
            self.log.debug(
                "Pop %s/%s from names bucket (%s remaining)",
                name.nick, name.chan, namesBucket.length
            );
            return callbacks.onJoin(
                server, createUser(name.nick), name.chan, "names"
            );
        };
        var purgeNames = function() {
            var promise = popName();
            if (promise) {
                promise.finally(function() {
                    purgeNames();
                });
            }
        };

        connInst.addListener("names", function(chan, names, msg) {
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
                self.log.info(
                    "NAMEs: Adding %s nicks from %s.", userlist.length, chan
                );
                self.log.debug("Names bucket has %s entries", namesBucket.length);
                if (!processingBucket) {
                    processingBucket = true;
                    purgeNames();
                }
            }
        });
        // listen for mode changes
        connInst.addListener("+mode", function(channel, by, mode, arg) {
            callbacks.onMode(server, channel, by, mode, true, arg);
        });
        connInst.addListener("-mode", function(channel, by, mode, arg) {
            callbacks.onMode(server, channel, by, mode, false, arg);
        });
        connInst.addListener("message", function(from, to, text) {
            if (to.indexOf("#") !== 0) { return; }
            callbacks.onMessage(
                server, createUser(from), createUser(to),
                actions.irc.createMessage(text)
            );
        });
        connInst.addListener("ctcp-privmsg", function(from, to, text) {
            if (to.indexOf("#") !== 0) { return; }
            if (text.indexOf("ACTION ") === 0) {
                callbacks.onMessage(
                    server, createUser(from), createUser(to),
                    actions.irc.createEmote(
                        text.substring("ACTION ".length)
                    )
                );
            }
        });
        connInst.addListener("notice", function(from, to, text) {
            if (to.indexOf("#") !== 0) { return; }
            if (from) { // ignore server notices
                callbacks.onMessage(
                    server, createUser(from), createUser(to),
                    actions.irc.createNotice(text)
                );
            }
        });
        connInst.addListener("topic", function(channel, topic, nick) {
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
            callbacks.onMessage(
                server, createUser(nick), createUser(channel),
                actions.irc.createTopic(topic)
            );
        });
    }
    // === Attach client listeners ===
    else {
        // just listen for PMs for clients. If you listen for rooms, you'll get
        // duplicates since the bot will also invoke the callback fn!
        connInst.addListener("message", function(from, to, text) {
            if (to.indexOf("#") === 0) { return; }
            callbacks.onMessage(
                server, createUser(from), createUser(to),
                actions.irc.createMessage(text)
            );
        });
        connInst.addListener("notice", function(from, to, text) {
            if (!from || to.indexOf("#") === 0) { return; }
            callbacks.onMessage(
                server, createUser(from), createUser(to),
                actions.irc.createNotice(text)
            );
        });
        connInst.addListener("ctcp-privmsg", function(from, to, text) {
            if (to.indexOf("#") === 0) { return; }
            if (text.indexOf("ACTION ") === 0) {
                callbacks.onMessage(
                    server, createUser(from), createUser(to),
                    actions.irc.createEmote(
                        text.substring("ACTION ".length)
                    )
                );
            }
        });
    }
};
module.exports.BridgedClient = BridgedClient;

var setTopic = function(self, room, topic) {
    // join the room if we haven't already
    var defer = q.defer();
    joinChannel(self, room.channel).done(function() {
        self.log.info("Setting topic to %s in channel %s", topic, room.channel);
        self.unsafeClient.send("TOPIC", room.channel, topic);
        defer.resolve();
    }, function(e) {
        defer.reject(e);
    });
    return defer.promise;
};

var sendMessage = function(self, room, msgType, text) {
    // join the room if we haven't already
    var defer = q.defer();
    msgType = msgType || "message";
    self._connectDefer.promise.then(function() {
        return joinChannel(self, room.channel);
    }).done(function() {
        if (msgType == "action") {
            self.unsafeClient.action(room.channel, text);
        }
        else if (msgType == "notice") {
            self.unsafeClient.notice(room.channel, text);
        }
        else if (msgType == "message") {
            self.unsafeClient.say(room.channel, text);
        }
        defer.resolve();
    });
    return defer.promise;
};

var joinChannel = function(self, channel) {
    if (!self.unsafeClient) {
        return q.reject("No client");
    }
    if (Object.keys(self.unsafeClient.chans).indexOf(channel) !== -1) {
        return q();
    }
    if (channel.indexOf("#") !== 0) {
        // PM room
        return q();
    }
    if (self.server.isExcludedChannel(channel)) {
        return q.reject(channel + " is a do-not-track channel.");
    }
    var defer = q.defer();
    self.log.debug("Joining channel %s", channel);
    self._addChannel(channel);
    var client = self.unsafeClient;
    // listen for failures to join a channel (e.g. +i, +k)
    var failFn = function(err) {
        if (!err || !err.args) { return; }
        var failCodes = [
            "err_nosuchchannel", "err_toomanychannels", "err_channelisfull",
            "err_inviteonlychan", "err_bannedfromchan", "err_badchannelkey"
        ];
        self.log.error("Join channel %s : %s", channel, err);
        if (failCodes.indexOf(err.command) !== -1 &&
                err.args.indexOf(channel) !== -1) {
            self.log.error("Cannot track channel %s: %s", channel, err.command);
            client.removeListener("error", failFn);
            defer.reject(err);
        }
    };
    client.once("error", failFn);

    // add a timeout to try joining again
    setTimeout(function() {
        // promise isn't resolved yet and we still want to join this channel
        if (defer.promise.isPending() && self.chanList.indexOf(channel) !== -1) {
            self.log.error("Timed out trying to join %s - trying again.", channel);
            // try joining again.
            joinChannel(self, channel).done(function(s) {
                defer.resolve(s);
            }, function(e) {
                defer.reject(e);
            });
        }
    }, JOIN_TIMEOUT_MS);

    self.unsafeClient.join(channel, function() {
        self.log.debug("Joined channel %s", channel);
        client.removeListener("error", failFn);
        var room = new IrcRoom(self.server, channel);
        defer.resolve(room);
    });

    return defer.promise;
};
