"use strict";
var irc = require("irc");
var q = require("q");
var logging = require("../logging");
var log = logging.get("client-connection");


// The time we're willing to wait for a connect callback when connecting to IRC.
var CONNECT_TIMEOUT_MS = 30 * 1000; // 30s
// The delay between messages when there are >1 messages to send.
var FLOOD_PROTECTION_DELAY_MS = 700;
// The max amount of time we should wait for the server to ping us before reconnecting.
// Servers ping infrequently (2-3mins) so this should be high enough to allow up
// to 2 pings to lapse before reconnecting (5-6mins).
var PING_TIMEOUT_MS = 1000 * 60 * 10;
// The minimum time to wait between connection attempts if we were disconnected
// due to throttling.
var THROTTLE_WAIT_MS = 20 * 1000;


/**
 * Create an IRC connection instance. Wraps the node-irc library to handle
 * connections correctly.
 * @constructor
 * @param {IrcClient} ircClient The new IRC client.
 * @param {string} domain The domain (for logging purposes)
 * @param {string} nick The nick (for logging purposes)
 */
function ConnectionInstance(ircClient, domain, nick) {
    this.client = ircClient;
    this.domain = domain;
    this.nick = nick;
    this._listenForErrors();
    this._listenForPings();
    this.dead = false;
    this.state = "created"; // created|connecting|connected
    this._connectDefer = q.defer();
}

/**
 * Connect this client to the server. There are zero guarantees this will ever
 * connect.
 * @return {Promise} Resolves if connected; rejects if failed to connect.
 */
ConnectionInstance.prototype.connect = function() {
    if (this.dead) {
        throw new Error("connect() called on dead client: " + this.nick);
    }
    this.state = "connecting";
    var self = this;
    var domain = self.domain;
    var gotConnectedCallback = false;
    setTimeout(function() {
        if (!gotConnectedCallback && !self.dead) {
            log.error(
                "%s@%s still not connected after %sms. Killing connection.",
                self.nick, domain, CONNECT_TIMEOUT_MS
            );
            self.disconnect("timeout");
        }
    }, CONNECT_TIMEOUT_MS);

    self.client.connect(function() {
        gotConnectedCallback = true;
        self.state = "connected";
        self._connectDefer.resolve(self);
    });
    return this._connectDefer.promise;
};

/**
 * Blow away the connection. You MUST destroy this object afterwards.
 * @param {string} reason - Reason to reject with. One of:
 * throttled|irc_error|net_error|timeout|raw_error
 */
ConnectionInstance.prototype.disconnect = function(reason) {
    if (this.dead) {
        return;
    }
    log.info(
        "disconnect()ing %s@%s - %s", this.nick, this.domain, reason
    );
    this.dead = true;
    this.client.disconnect();
    if (this.state !== "connected") {
        // we never resolved this defer, so reject it.
        this._connectDefer.reject(reason);
    }
    if (this.state === "connected" && this.onDisconnect) {
        // we only invoke onDisconnect once we've had a successful connect.
        // Connection *attempts* are managed by the create() function so if we
        // call this now it would potentially invoke this 3 times (once per
        // connection instance!). Each time would have dead=false as they are
        // separate objects.
        this.onDisconnect();
    }
};

ConnectionInstance.prototype.addListener = function(eventName, fn) {
    var self = this;
    this.client.addListener(eventName, function() {
        if (self.dead) {
            log.error(
                "%s@%s RECV a %s event for a dead connection",
                self.nick, self.domain, eventName
            );
            return;
        }
        // do the callback
        fn.apply(fn, arguments);
    });
};

ConnectionInstance.prototype._listenForErrors = function() {
    var self = this;
    var domain = self.domain;
    var nick = self.nick;
    self.client.addListener("error", function(err) {
        log.error("Server: %s (%s) Error: %s", domain, nick, JSON.stringify(err));
        var failCodes = [
            "err_nosuchchannel", "err_toomanychannels", "err_channelisfull",
            "err_inviteonlychan", "err_bannedfromchan", "err_badchannelkey"
        ];
        if (err && err.command) {
            if (failCodes.indexOf(err.command) !== -1) {
                return; // don't disconnect for these error codes.
            }
        }
        self.disconnect("irc_error");
    });
    self.client.addListener("netError", function(err) {
        log.error(
            "Server: %s (%s) Network Error: %s", domain, nick,
            JSON.stringify(err, undefined, 2)
        );
        self.disconnect("net_error");
    });
    self.client.addListener("raw", function(msg) {
        if (logging.isVerbose()) {
            log.debug(
                "%s@%s: %s", nick, domain, JSON.stringify(msg)
            );
        }
        if (msg && (msg.command === "ERROR" || msg.rawCommand === "ERROR")) {
            log.error(
                "%s@%s: %s", nick, domain, JSON.stringify(msg)
            );
            var wasThrottled = false;
            if (msg.args) {
                var errText = ("" + msg.args[0]) || "";
                errText = errText.toLowerCase();
                wasThrottled = errText.indexOf("throttl") !== -1;
                if (wasThrottled) {
                    self.disconnect("throttled");
                }
            }
            if (!wasThrottled) {
                self.disconnect("raw_error");
            }
        }
    });
};

ConnectionInstance.prototype._listenForPings = function() {
    // BOTS-65 : A client can get ping timed out and not reconnect.
    // ------------------------------------------------------------
    // The client is doing IRC ping/pongs, but there is no check to say
    // "hey, the server hasn't pinged me in a while, it's probably dead". The
    // RFC for pings states that pings are sent "if no other activity detected
    // from a connection." so we need to count anything we shove down the wire
    // as a ping refresh.
    var self = this;
    var domain = self.domain;
    var nick = self.nick;
    var pingTimer;
    function _keepAlivePing() { // refresh the ping timer
        if (pingTimer) {
            clearTimeout(pingTimer);
        }
        pingTimer = setTimeout(function() {
            log.info(
                "Ping timeout: knifing connection for %s on %s",
                domain, nick
            );
            // Just emit an netError which clients need to handle anyway.
            self.client.emit("netError", {
                msg: "Client-side ping timeout"
            });
        }, PING_TIMEOUT_MS);
    }
    self.client.on("ping", function(svr) {
        log.debug("Received ping from %s directed at %s", svr, nick);
        _keepAlivePing();
    });
    // decorate client.send to refresh the timer
    var realSend = self.client.send;
    self.client.send = function(command) {
        _keepAlivePing();
        realSend.apply(self.client, arguments);
    };
};


module.exports = {

    /**
     * Create an IRC client connection and connect to it.
     * @param {IrcServer} server The server to connect to.
     * @param {Object} opts Options for this connection.
     * @param {string} opts.nick The nick to use.
     * @param {string} opts.username The username to use.
     * @param {string} opts.realname The real name of the user.
     * @param {string} opts.password The password to give NickServ.
     * @param {Function} onCreatedCallback Called with the client when created.
     * @return {Promise} Resolves to an ConnectionInstance or rejects.
     */
    create: function(server, opts, onCreatedCallback) {
        if (!opts.nick || !server) {
            throw new Error("Bad inputs. Nick: " + opts.nick);
        }
        onCreatedCallback = onCreatedCallback || function() {};
        var connectionOpts = {
            userName: opts.username,
            realName: opts.realname,
            password: opts.password,
            autoConnect: false,
            autoRejoin: true,
            floodProtection: true,
            floodProtectionDelay: FLOOD_PROTECTION_DELAY_MS,
            port: server.getPort(),
            secure: server.useSsl()
        };
        var d = q.defer();
        var returnClient = function(cli) {
            d.resolve(cli);
        };
        var retryConnection = function(e) {
            var nodeClient = new irc.Client(
                server.domain, opts.nick, connectionOpts
            );
            var inst = new ConnectionInstance(
                nodeClient, server.domain, opts.nick
            );
            onCreatedCallback(inst);
            return inst.connect();
        };
        // try 3 times to connect then give up
        // TODO: Surely there is a nicer construct than this arrow of doom?
        retryConnection().then(returnClient, function(reason) {
            setTimeout(function() {
                retryConnection().then(returnClient, function(reason) {
                    setTimeout(function() {
                        retryConnection().then(returnClient, function(reason) {
                            d.reject("Tried 3 connection attempts; failed.");
                        });
                    }, 5000 + (reason === "throttled" ? THROTTLE_WAIT_MS : 0));
                });
            }, 2000 + (reason === "throttled" ? THROTTLE_WAIT_MS : 0));
        });

        return d.promise;
    },

};
