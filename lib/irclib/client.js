"use strict";

var q = require("q");
var ident = require("./ident");
var actions = require("../models/actions");
var clientConnection = require("./client-connection");
var pool = require("./server-pool");
var names = require("./names");
var IrcRoom = require("../models/rooms").IrcRoom;
var log = require("../logging").get("irc-client");

/**
 * Create a new virtual IRC user.
 * @constructor
 * @param {Object} ircUser : The IRC user to create a connection for.
 * @param {String} userId : The real matrix user ID for this virtual IRC user.
 * @param {boolean} isBot : True if this is the bot
 */
function VirtualIrcUser(ircUser, userId, isBot) {
    this.server = ircUser.server;
    this.nick = ircUser.nick;
    this.userId = userId;
    this.isBot = Boolean(isBot);
    this.lastActionTs = Date.now();
    this.connectDefer = q.defer();
}

/**
 * @param {Object} callbacks
 * @return {ConnectionInstance} A new connected connection instance.
 */
VirtualIrcUser.prototype.connect = function(callbacks) {
    var self = this;
    var server = this.server;

    var nameInfo = names.getIrcNames(
        this.server, this.nick, this.userId
    );

    var password = this.isBot ? server.nickPass : undefined;

    log.info("Connecting to IRC server %s as %s (user=%s)",
        server.domain, nameInfo.nick, nameInfo.username);
    var defer = q.defer();
    clientConnection.create(server, {
        nick: nameInfo.nick,
        username: nameInfo.username,
        realname: nameInfo.realname,
        password: password
    }, function(connInst) {
        // === Attach bot listeners ===
        if (self.isBot) {
            // make the bot listen for join/parts
            connInst.addListener("part", function(chan, nick, reason, msg) {
                callbacks.onPart(server, nick, chan, "part");
            });
            connInst.addListener("quit", function(nick, reason, chans, msg) {
                chans = chans || [];
                chans.forEach(function(chan) {
                    callbacks.onPart(server, nick, chan, "quit");
                });
            });
            connInst.addListener("kick", function(chan, nick, by, reason, msg) {
                callbacks.onPart(server, nick, chan, "kick");
            });
            connInst.addListener("join", function(chan, nick, msg) {
                callbacks.onJoin(server, nick, chan, "join");
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
                log.debug(
                    "Pop %s/%s from names bucket (%s remaining)",
                    name.nick, name.chan, namesBucket.length
                );
                callbacks.onJoin(server, name.nick, name.chan, "names");
                setTimeout(popName, 1000);
            };

            connInst.addListener("names", function(chan, names, msg) {
                if (names) {
                    Object.keys(names).forEach(function(nick) {
                        namesBucket.push({
                            chan: chan,
                            nick: nick
                        });
                        // var opsLevel = names[nick]; // + @ or empty string
                        // TODO do something with opsLevel
                    });
                    log.debug("Names bucket has %s entries", namesBucket.length);
                    if (!processingBucket) {
                        processingBucket = true;
                        popName();
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
                callbacks.onMessage(
                    server, from, to, actions.irc.createMessage(text)
                );
            });
            connInst.addListener("ctcp-privmsg", function(from, to, text) {
                if (text.indexOf("ACTION ") === 0) {
                    callbacks.onMessage(server, from, to, actions.irc.createEmote(
                        text.substring("ACTION ".length)
                    ));
                }
            });
            connInst.addListener("notice", function(from, to, text) {
                if (from) { // ignore server notices
                    callbacks.onMessage(
                        server, from, to, actions.irc.createNotice(text)
                    );
                }
            });
            connInst.addListener("topic", function(channel, topic, nick) {
                if (nick.indexOf("@") !== -1) {
                    var match = nick.match(
                        // https://github.com/martynsmith/node-irc/blob/master/lib/parse_message.js#L26
                        /^([_a-zA-Z0-9\[\]\\`^{}|-]*)(!([^@]+)@(.*))?$/
                    );
                    if (match) {
                        nick = match[1];
                    }
                }
                callbacks.onMessage(
                    server, nick, channel, actions.irc.createTopic(topic)
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
                    server, from, to, actions.irc.createMessage(text)
                );
            });
            connInst.addListener("notice", function(from, to, text) {
                if (!from || to.indexOf("#") === 0) { return; }
                callbacks.onMessage(
                    server, from, to, actions.irc.createNotice(text)
                );
            });
            connInst.addListener("ctcp-privmsg", function(from, to, text) {
                if (to.indexOf("#") === 0) { return; }
                if (text.indexOf("ACTION ") === 0) {
                    callbacks.onMessage(
                        server, from, to, actions.irc.createEmote(
                            text.substring("ACTION ".length)
                        )
                    );
                }
            });
        }
    }).done(function(connInst) {
        var localPort = -1;
        if (connInst.client.conn && connInst.client.conn.localPort) {
            localPort = connInst.client.conn.localPort;
        }
        if (localPort > 0) {
            ident.setMapping(nameInfo.username, localPort);
        }

        self.client = connInst.client;
        pool.onConnected(self);


        // we may have been assigned a different nick, so update it from source
        self.nick = connInst.client.nick;
        self.connectDefer.resolve();
        self._keepAlive();
        /*
        client.addListener("netError", function(err) {
            // reconnect after 10s
            log.info("Reconnecting %s in 10 seconds...", that.nick);
            that.client.disconnect();
            setTimeout(function() {
                that.connect(hooks).done(function(newClient) {
                    console.log("%s reconnected.", newClient.nick);
                    that.connectDefer.resolve();
                });
            }, 10000);
        }); */
        connInst.client.addListener("registered", function() {
            var oldNick = self.nick;
            if (oldNick !== self.client.nick) {
                log.info(
                    "REGISTERED: Nick changed from '" + oldNick + "' to '" +
                    self.client.nick + "'."
                );
                self.nick = self.client.nick;
                pool.updateIrcNick(self, oldNick, self.client.nick);
            }
        });
        connInst.client.addListener("nick", function(old, newNick) {
            if (old === self.nick) {
                log.info("NICK: Nick changed from '" + old + "' to '" + newNick + "'.");
                self.nick = newNick;
                pool.updateIrcNick(self, old, newNick);
            }
        });
        defer.resolve(connInst);
    }, function(e) {
        defer.reject(e);
    });

    return defer.promise;
};

VirtualIrcUser.prototype.disconnect = function(reason) {
    this.connectDefer = q.defer();
    if (!this.client) {
        return q();
    }
    var d = q.defer();
    this.client.disconnect(reason, function() {
        d.resolve();
    });
    return d.promise;
};

/**
 * Change this user's nick.
 * @param {string} newNick : The new nick for the user.
 * @return {Promise<String>} Which resolves to a message to be sent to the user.
 */
VirtualIrcUser.prototype.changeNick = function(newNick) {
    // TODO: This is dupe logic with server.js
    // strip illegal chars according to RFC 1459 Sect 2.3.1
    // but allow _ because most IRC servers allow that.
    var nick = newNick.replace(/[^A-Za-z0-9\]\[\^\\\{\}\-`_]/g, "");
    // nicks must start with a letter
    if (!/^[A-Za-z]/.test(nick)) {
        return q.reject("Nick '" + nick + "' must start with a letter.");
    }
    var maxNickLen = 9; // RFC 1459 default
    if (this.client.supported && typeof this.client.supported.nicklength == "number") {
        maxNickLen = this.client.supported.nicklength;
    }
    if (nick.length > maxNickLen) {
        return q.reject("Nick '" + nick + "' is too long. (Max: " + maxNickLen + ")");
    }
    if (nick === this.nick) {
        return q("Your nick is already '" + nick + "'.");
    }

    var d = q.defer();
    this.client.once("nick", function(old, n) {
        d.resolve("Nick changed from '" + old + "' to '" + n + "'.");
    });
    this.client.send("NICK", nick);
    return d.promise;
};

VirtualIrcUser.prototype.joinChannel = function(channel) {
    return joinChannel(this, channel);
};

VirtualIrcUser.prototype.leaveChannel = function(channel) {
    if (!this.client) {
        return q(); // we were never connected to the network.
    }
    if (Object.keys(this.client.chans).indexOf(channel) === -1) {
        return q(); // we were never joined to it.
    }
    if (channel.indexOf("#") !== 0) {
        return q(); // PM room
    }
    var self = this;
    var defer = q.defer();
    log.debug("[%s,%s,%s] Leaving channel %s",
        this.userId, this.server.domain, this.nick, channel
    );
    this.client.part(channel, "User left", function() {
        log.debug("[%s,%s,%s] Left channel %s",
            self.userId, self.server.domain, self.nick, channel
        );
        defer.resolve();
    });

    return defer.promise;
};

VirtualIrcUser.prototype.sendAction = function(room, action) {
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
            log.error("Unknown action type: %s", action.action);
    }
    return q.reject("Unknown action type: %s", action.action);
};

VirtualIrcUser.prototype.whois = function(nick) {
    var defer = q.defer();
    var self = this;
    this.client.whois(nick, function(whois) {
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

VirtualIrcUser.prototype._keepAlive = function() {
    this.lastActionTs = Date.now();
    if (this.server.idleTimeout > 0) {
        if (this._idleTimeout) {
            // stop the timeout
            clearTimeout(this._idleTimeout);
        }
        log.debug(
            "Starting %ss idle timeout for %s (%s)",
            this.server.idleTimeout, this.nick, this.userId
        );
        // restart the timeout
        var self = this;
        this._idleTimeout = setTimeout(function() {
            log.info(
                "Idle timeout for %s (%s) has expired", self.nick, self.userId
            );
            self.disconnect(
                "Idle timeout reached: " + self.server.idleTimeout + "s"
            ).done(function() {
                log.info("Idle timeout reached: Disconnected %s on %s.",
                    self.nick, self.server.domain);
                pool.removeVirtualUser(self);
            }, function(e) {
                log.error("Error when disconnecting %s on server %s: %s",
                    self.nick, self.server.domain, JSON.stringify(e));
                // still remove them so another client is made; we don't really
                // know how good the state of this one is now.
                pool.removeVirtualUser(self);
            });
        }, (1000 * this.server.idleTimeout));
    }
};
VirtualIrcUser.prototype.getLastActionTs = function() {
    return this.lastActionTs;
};
module.exports.VirtualIrcUser = VirtualIrcUser;

var setTopic = function(that, room, topic) {
    // join the room if we haven't already
    var defer = q.defer();
    joinChannel(that, room.channel).done(function() {
        log.info("Setting topic to %s in channel %s", topic, room.channel);
        that.client.send("TOPIC", room.channel, topic);
        defer.resolve();
    });
    return defer.promise;
};

var sendMessage = function(that, room, msgType, text) {
    // join the room if we haven't already
    var defer = q.defer();
    msgType = msgType || "message";
    that.connectDefer.promise.then(function() {
        return joinChannel(that, room.channel);
    }).done(function() {
        if (msgType == "action") {
            that.client.action(room.channel, text);
        }
        else if (msgType == "notice") {
            that.client.notice(room.channel, text);
        }
        else if (msgType == "message") {
            that.client.say(room.channel, text);
        }
        defer.resolve();
    });
    return defer.promise;
};

var joinChannel = function(that, channel) {
    if (Object.keys(that.client.chans).indexOf(channel) !== -1) {
        return q();
    }
    if (channel.indexOf("#") !== 0) {
        // PM room
        return q();
    }
    if (that.server.doNotTrackChannels.indexOf(channel) !== -1) {
        return q.reject(channel + " is a do-not-track channel.");
    }

    var defer = q.defer();
    log.debug("[%s,%s,%s] Joining channel %s",
        that.userId, that.server.domain, that.nick, channel
    );
    var client = that.client;
    // listen for failures to join a channel (e.g. +i, +k)
    var failFn = function(err) {
        if (!err || !err.args) { return; }
        var failCodes = [
            "err_nosuchchannel", "err_toomanychannels", "err_channelisfull",
            "err_inviteonlychan", "err_bannedfromchan", "err_badchannelkey"
        ];
        if (failCodes.indexOf(err.command) !== -1 &&
                err.args.indexOf(channel) !== -1) {
            log.error("Cannot track channel %s: %s", channel, err.command);
            client.removeListener("error", failFn);
            defer.reject(err);
        }
    };
    client.once("error", failFn);
    that.client.join(channel, function() {
        log.debug("[%s,%s,%s] Joined channel %s",
            that.userId, that.server.domain, that.nick, channel
        );
        client.removeListener("error", failFn);
        var room = new IrcRoom(that.server, channel);
        defer.resolve(room);
    });

    return defer.promise;
};
