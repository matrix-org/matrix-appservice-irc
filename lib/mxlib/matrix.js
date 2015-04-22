/*
 * Public API for interacting with Matrix.
 */
"use strict";
var q = require("q");

var sdk = require("./cs-extended-sdk");
var roomModels = require("../models/rooms");
var users = require("../models/users");
var log = require("../logging").get("matrix");

var hsDomain;
var appServiceUserId;
var stripHtmlTags = /(<([^>]+)>)/ig;

var actionToMsgtypes = {
    message: "m.text",
    emote: "m.emote",
    notice: "m.notice"
};

var mkUserId = function(localpart) {
    return "@"+localpart+":"+hsDomain;
};

var getAliasLocalpart = function(alias) {
    return alias.split(":")[0].substring(1);
};

module.exports.getAppServiceUserId = function() {
    return appServiceUserId;
};

module.exports.setMatrixClientConfig = function(config) {
    hsDomain = config.domain;
    appServiceUserId = "@" + config.localpart + ":" + hsDomain;
    sdk.setClientConfig(config);
};

module.exports.decodeMxc = function(mxcUri) {
    // looks like mxc://matrix.org/mxfsKGddpulqOiEVUcNcRUcb
    var client = sdk.getClientAs();
    return client.credentials.baseUrl + "/_matrix/media/v1/download/" + 
        mxcUri.substring(6);
};


// return a matrix lib for this request.
module.exports.getMatrixLibFor = function(request) {
    return new MatrixLib(request);
};

function MatrixLib(request) {
    this.request = request;
    this.log = (request ? request.log : log);
}

MatrixLib.prototype._getClient = function(userId) {
    return sdk.getClientAs(userId, (this.request ? this.request.id : null));
};

MatrixLib.prototype.createRoomWithUser = function(fromUserId, toUserId, name) {
    var defer = q.defer();
    var client = this._getClient(fromUserId);
    var room;
    client.createRoom({
        name: name,
        visibility: "private"
    }).then(function(response) {
        room = roomModels.matrix.createRoom(response.room_id);
        return client.invite(response.room_id, toUserId);
    }).then(function() {
        defer.resolve(room);
    }).done(undefined, function(err) {
        defer.reject(err);
    });

    return defer.promise;
};

MatrixLib.prototype.createRoomWithAlias = function(alias, name, topic) {
    var aliasLocalpart = getAliasLocalpart(alias);
    var defer = q.defer();
    var client = this._getClient();
    // if alias already used (M_UNKNOWN), query it and use that. Return a Room.
    client.createRoom({
        room_alias_name: aliasLocalpart,
        name: name,
        topic: topic,
        visibility: "public"
    }).then(function(response) {
        defer.resolve(roomModels.matrix.createRoom(response.room_id));
    }, function(err) {
        if (err.errcode === "M_UNKNOWN") {
            // alias already taken, must be us. Join the room alias.
            return client.joinRoom(alias);
        }
        else {
            defer.reject("Failed to create room: %s", JSON.stringify(err));
        }
    }).then(function(response) {
        if (response) {
            defer.resolve(roomModels.matrix.createRoom(response.room_id));
        }
    }).catch(log.logErr);

    return defer.promise;
};

MatrixLib.prototype.leaveRoom = function(userId, roomId) {
    var client = this._getClient(userId);
    return client.leave(roomId);
};

MatrixLib.prototype.isPmRoom = function(userId, roomId, pmRoomUserId) {
    var defer = q.defer();
    var client = this._getClient(userId);
    client.roomState(roomId).then(function(response) {
        var joinedMembers = 0;
        var pmMemberPresent = false;
        for (var i=0; i<response.length; i++) {
            var event = response[i];
            if (event.type === "m.room.member" && 
                    event.content.membership === "join") {
                joinedMembers += 1;
                if (pmRoomUserId === event.state_key) {
                    pmMemberPresent = true;
                }
            }
        }
        defer.resolve(joinedMembers === 2 && pmMemberPresent);
    },
    function(err) {
        defer.reject(err);
    }).catch(log.logErr);
    return defer.promise;
};

MatrixLib.prototype.sendAction = function(room, from, action) {
    this.log.info("sendAction -> %s", JSON.stringify(action));
    if (actionToMsgtypes[action.action]) {
        var msgtype = actionToMsgtypes[action.action];
        if (action.htmlBody) {
            return sendHtml(this, room, from, msgtype, action.htmlBody);
        }
        return sendMessage(this, room, from, msgtype, action.body);
    }
    else if (action.action === "topic") {
        return setTopic(this, room, from, action.topic);
    }
    return q.reject("Unknown action: "+action.action);
};

MatrixLib.prototype.joinRoom = function(roomId, matrixUser) {
    // client is the specified matrix user or the bot if a matrix user isn't
    // specified.
    var lib = this;
    var defer = q.defer();
    var client = matrixUser ? lib._getClient(matrixUser.userId) : lib._getClient();
    client.joinRoom(roomId).done(function(response) {
        defer.resolve(response);
    }, function(err) {
        if (err.errcode == "M_FORBIDDEN") {
            // can the bot invite us? If so, join the send msg.
            var botClient = lib._getClient();
            botClient.invite(roomId, matrixUser.userId).done(function(r) {
                // now join.
                client.joinRoom(roomId).done(function(response) {
                    lib.log.info("Joined room (bot invited).");
                    defer.resolve(response);
                }, function(err) {
                    lib.log.error(
                        "joinRoom: Couldn't join room (bot invited): %s", 
                        JSON.stringify(err)
                    );
                    defer.reject(err);
                });
            }, function(err) {
                // the bot couldn't invite the user.
                // try joining as the bot THEN inviting.
                botClient.joinRoom(roomId).then(function(response) {
                    return botClient.invite(roomId, matrixUser.userId);
                }).then(function(response) {
                    return client.joinRoom(roomId);
                }).done(function(response) {
                    lib.log.info("Joined room (bot joined then invited).");
                    defer.resolve(response);
                }, function(err) {
                    lib.log.error(
                        "joinRoom: Couldn't join room (bot couldn't invite): %s",
                        JSON.stringify(err)
                    );
                    defer.reject(err);
                });
            });
        }
        else {
            defer.reject(err);
        }
    });
    return defer.promise;
};

MatrixLib.prototype.invite = function(room, userIdToInvite) {
    var client = this._getClient();
    return client.invite(room.roomId, userIdToInvite);
};

var setTopic = function(lib, room, from, topic) {
    var defer = q.defer();
    var client = lib._getClient(from.userId);
    client.setRoomTopic(room.roomId, topic).then(function(suc) {
        defer.resolve(suc);
    },
    function(err) {
        // XXX should really be trying to join like on sendMessage.
        defer.reject(err);
    });
    return defer.promise;
};

var sendMessage = function(lib, room, from, msgtype, text) {
    msgtype = msgtype || "m.text";
    var content = {
        msgtype: msgtype,
        body: text
    };
    return sendMessageEvent(lib, room, from, content);
};

var sendHtml = function(lib, room, from, msgtype, html) {
    msgtype = msgtype || "m.text";
    var fallback = html.replace(stripHtmlTags, "");
    var content = {
        msgtype: msgtype,
        body: fallback,
        format: "org.matrix.custom.html",
        formatted_body: html
    };
    return sendMessageEvent(lib, room, from, content);
};

var sendMessageEvent = function(lib, room, from, content, joinState, existingDefer) {
    var defer = existingDefer || q.defer();
    var client = lib._getClient(from.userId);
    client.sendMessage(room.roomId, content).then(function(suc) {
        defer.resolve(suc);
    },
    function(err) {
        if (err.errcode == "M_FORBIDDEN" && !joinState) {
            // try joining the room
            lib.joinRoom(room.roomId, from).done(function(response) {
                sendMessageEvent(lib, room, from, content, "join", defer);
            }, function(err) {
                lib.log.error("sendMessageEvent: Failed to join room. %s", err);
                defer.reject(err);
            });
        }
        else {
            lib.log.error("sendMessageEvent: %s", JSON.stringify(err));
            defer.reject(err);
        }
    }).catch(log.logErr);
    return defer.promise;
};


// fudge a memory cache for now for perf; we need to actually persist in a db
// if the user exists, and do suitable recovery if it turns out the cache is
// wrong and they do not exist.
var userCache = {
//  localpart: user
};
var getMatrixUser = function(userLocalpart, displayName) {
    if (userCache[userLocalpart]) {
        return q(userCache[userLocalpart]);
    }

    // TODO optimise this by not trying to register users which
    // have already been made
    var defer = q.defer();

    var client = sdk.getClientAs();
    client.register("m.login.application_service", {
        user: userLocalpart
    }).done(function(response) {
        // set their display name
        var userClient = sdk.getClientAs(response.user_id);
        // return success even if we don't set the display name (hence finally)
        userClient.setDisplayName(displayName).finally(function() {
            userCache[userLocalpart] = users.matrix.createUser(
                response.user_id, true
            );
            defer.resolve(userCache[userLocalpart]);
        });
    },
    function(err) {
        if (err.errcode == "M_USER_IN_USE") {
            // made it before
            userCache[userLocalpart] = users.matrix.createUser(
                mkUserId(userLocalpart), true
            );
            defer.resolve(userCache[userLocalpart]);
        }
        else {
            defer.reject({});
        }
    });
    return defer.promise;
};

// IRC User -> Matrix User (Promise returned)
module.exports.ircToMatrixUser = function(user) {
    if (user.protocol !== "irc") {
        log.error("Bad src protocol: %s", user.protocol);
        return;
    }
    var userLocalpart = user.server.getUserLocalpart(user.nick);
    return getMatrixUser(userLocalpart, user.nick+" (IRC)");
};