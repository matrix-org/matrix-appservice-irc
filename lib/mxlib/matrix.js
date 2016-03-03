/*
 * Public API for interacting with Matrix.
 */
"use strict";

var Promise = require("bluebird");
var promiseutil = require("../promiseutil");
var MatrixRoom = require("../models/rooms").MatrixRoom;
var MatrixUser = require("../models/users").MatrixUser;
var log = require("../logging").get("matrix");
var store = require("../store");

var globalBridge = null;
var hsDomain;
var stripHtmlTags = /(<([^>]+)>)/ig;

var actionToMsgtypes = {
    message: "m.text",
    emote: "m.emote",
    notice: "m.notice"
};

var mkUserId = function(localpart) {
    return "@" + localpart + ":" + hsDomain;
};

module.exports.setMatrixClientConfig = function(config, bridge) {
    hsDomain = config.domain;
    globalBridge = bridge;
};

module.exports.decodeMxc = function(mxcUri) { // actions.js (de-singleton) TODO
    // looks like mxc://matrix.org/mxfsKGddpulqOiEVUcNcRUcb
    var client = globalBridge.getClientFactory().getClientAs();
    return client.mxcUrlToHttp(mxcUri);
};

/**
 * Obtain the Matrix library in the context of the given request.
 * @constructor
 * @param {!Request} request : The request to scope the library to, or null for
 * no scope (e.g. something done on startup).
 * @param {Object} defaultLogger : The default logger to scope to.
 */
function MatrixLib(request, defaultLogger) {
    this.request = request;
    this.log = (request ? request.log : defaultLogger);
}


// return a matrix lib for this request.
module.exports.getMatrixLibFor = function(request) {
    return new MatrixLib(request, log);
};

/**
 * @param {String=} userId : The user ID to get a client for, or nothing to get
 * the bot's client.
 * @return {Object} The Matrix Client SDK instance for this user.
 */
MatrixLib.prototype._getClient = function(userId) {
    return globalBridge.getClientFactory().getClientAs(userId, null);
};

MatrixLib.prototype.addAlias = function(roomId, alias) {
    var defer = promiseutil.defer();
    var client = this._getClient();
    client.createAlias(
        alias, roomId
    ).done(function(res) {
        defer.resolve(res);
    }, function(err) {
        defer.reject(err);
    });
    return defer.promise;
};

MatrixLib.prototype.createRoomWithUser = function(fromUserId, toUserId, name) {
    var defer = promiseutil.defer();
    var client = this._getClient(fromUserId);
    var room;
    client.createRoom({
        name: name,
        visibility: "private"
    }).then(function(response) {
        room = new MatrixRoom(response.room_id);
        return client.invite(response.room_id, toUserId);
    }).then(function() {
        defer.resolve(room);
    }).done(undefined, function(err) {
        defer.reject(err);
    });

    return defer.promise;
};

MatrixLib.prototype.leaveRoom = function(userId, roomId) {
    var client = this._getClient(userId);
    return client.leave(roomId);
};

MatrixLib.prototype.sendAction = function(room, from, action) {
    this.log.info("sendAction -> %s", JSON.stringify(action));
    if (actionToMsgtypes[action.action]) {
        var msgtype = actionToMsgtypes[action.action];
        if (action.htmlBody) {
            return sendHtml(this, room, from, msgtype, action.htmlBody, action.body);
        }
        return sendMessage(this, room, from, msgtype, action.body);
    }
    else if (action.action === "topic") {
        return setTopic(this, room, from, action.topic);
    }
    return Promise.reject("Unknown action: " + action.action);
};

MatrixLib.prototype.joinRoom = function(roomId, matrixUser) {
    let intent = globalBridge.getIntent(matrixUser ? matrixUser.userId : null);
    return intent.join(roomId);
};

MatrixLib.prototype.invite = function(room, userIdToInvite) {
    var client = this._getClient();
    return client.invite(room.roomId, userIdToInvite);
};

MatrixLib.prototype.getDisplayName = function(roomId, userId) {
    var client = this._getClient();
    var defer = promiseutil.defer();
    client.getStateEvent(roomId, "m.room.member", userId).done(function(res) {
        defer.resolve(res.displayname);
    }, function(err) {
        defer.reject(err);
    });
    return defer.promise;
};

MatrixLib.prototype.initialSync = function(userId) {
    var client = this._getClient(userId);
    return client._http.authedRequest(
        undefined, "GET", "/initialSync", { limit: 0 }
    );
};

MatrixLib.prototype.roomState = function(roomId, userId) {
    var client = this._getClient(userId);
    return client.roomState(roomId);
};

function setTopic(lib, room, from, topic) {
    var defer = promiseutil.defer();
    var client = lib._getClient(from.userId);
    client.setRoomTopic(room.roomId, topic).then(function(suc) {
        defer.resolve(suc);
    },
    function(err) {
        // XXX should really be trying to join like on sendMessage.
        defer.reject(err);
    });
    return defer.promise;
}

function sendMessage(lib, room, from, msgtype, text) {
    msgtype = msgtype || "m.text";
    var content = {
        msgtype: msgtype,
        body: text
    };
    return sendMessageEvent(lib, room, from, content);
}

function sendHtml(lib, room, from, msgtype, html, fallback) {
    msgtype = msgtype || "m.text";
    fallback = fallback || html.replace(stripHtmlTags, "");
    var content = {
        msgtype: msgtype,
        body: fallback,
        format: "org.matrix.custom.html",
        formatted_body: html
    };
    return sendMessageEvent(lib, room, from, content);
}

/**
 * @param {*} lib
 * @param {*} room
 * @param {*} from
 * @param {Object} content
 * @param {string=} joinState
 * @param {Deferred=} existingDefer
 * @return {Promise} Which is resolved when the message has been sent, or
 * rejected if it failed to send.
 */
function sendMessageEvent(lib, room, from, content, joinState, existingDefer) {
    var defer = existingDefer || promiseutil.defer();
    var client = lib._getClient(from.userId);
    client.sendMessage(room.roomId, content).then(function(suc) {
        defer.resolve(suc);
    },
    function(err) {
        if (err.errcode == "M_FORBIDDEN" && !joinState) {
            // try joining the room
            lib.joinRoom(room.roomId, from).done(function(response) {
                sendMessageEvent(lib, room, from, content, "join", defer);
            }, function(err2) {
                lib.log.error("sendMessageEvent: Failed to join room. %s", err2);
                defer.reject(err2);
            });
        }
        else {
            lib.log.error("sendMessageEvent: %s", JSON.stringify(err));
            defer.reject(err);
        }
    }).catch(log.logErr);
    return defer.promise;
}

function getMatrixUser(userLocalpart, displayName) {
    var defer = promiseutil.defer();
    var client = globalBridge.getClientFactory().getClientAs();

    var createUserFn = function() {
        client.register(userLocalpart).done(function(response) {
            // user was create successfully
            var newUser = new MatrixUser(
                response.user_id, displayName, true
            );
            // set their display name
            var userClient = globalBridge.getClientFactory().getClientAs(response.user_id);
            userClient.setDisplayName(displayName).done(function() {
                // persist in db and return user regardless of store outcome
                store.users.set(newUser, userLocalpart, displayName, true).finally(
                function() {
                    defer.resolve(newUser);
                });
            }, function(e) {
                // non-fatal to not set the display name.
                // persist in db and return user regardless of store outcome
                store.users.set(newUser, userLocalpart, displayName, false).finally(
                function() {
                    defer.resolve(newUser);
                });
            });
        },
        function(err) {
            if (err.errcode == "M_USER_IN_USE") {
                // made them before, store this fact.
                var newUser = new MatrixUser(
                    mkUserId(userLocalpart), displayName, true
                );
                // persist in db and return user regardless of store outcome
                store.users.set(newUser, userLocalpart, displayName, false).finally(
                function() {
                    defer.resolve(newUser);
                });
            }
            else {
                defer.reject({});
            }
        });
    };

    // check db to see if we've made them before.
    store.users.get(userLocalpart).done(function(user) {
        if (user) {
            // excellent, return early.
            defer.resolve(user);
            return;
        }
        createUserFn();
    }, createUserFn);

    return defer.promise;
}

// IRC User -> Matrix User (Promise returned)
module.exports.ircToMatrixUser = function(user) {
    if (user.protocol !== "irc") {
        log.error("Bad src protocol: %s", user.protocol);
        return null;
    }
    var userLocalpart = user.server.getUserLocalpart(user.nick);
    return getMatrixUser(userLocalpart, user.nick + " (IRC)");
};
