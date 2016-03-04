/*
 * Public API for interacting with Matrix.
 */
"use strict";

var Promise = require("bluebird");
var promiseutil = require("../promiseutil");
var log = require("../logging").get("matrix");

var globalBridge = null;
var stripHtmlTags = /(<([^>]+)>)/ig;

var actionToMsgtypes = {
    message: "m.text",
    emote: "m.emote",
    notice: "m.notice"
};


module.exports.setMatrixClientConfig = function(config, bridge) {
    globalBridge = bridge;
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

MatrixLib.prototype.sendAction = function(room, from, action) {
    this.log.info("sendAction -> %s", JSON.stringify(action));
    if (actionToMsgtypes[action.type]) {
        var msgtype = actionToMsgtypes[action.type];
        if (action.htmlText) {
            return sendHtml(this, room, from, msgtype, action.htmlText, action.text);
        }
        return sendMessage(this, room, from, msgtype, action.text);
    }
    else if (action.type === "topic") {
        return setTopic(this, room, from, action.text);
    }
    return Promise.reject("Unknown action: " + action.type);
};

MatrixLib.prototype.joinRoom = function(roomId, matrixUser) {
    let intent = globalBridge.getIntent(matrixUser ? matrixUser.userId : null);
    return intent.join(roomId);
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
