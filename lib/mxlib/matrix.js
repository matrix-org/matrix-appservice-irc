/*
 * Public API for interacting with Matrix.
 */
"use strict";

var q = require("q");
var sdk = require("./cs-extended-sdk");
var MatrixRoom = require("../models/rooms").MatrixRoom;
var MatrixUser = require("../models/users").MatrixUser;
var log = require("../logging").get("matrix");
var store = require("../store");

var hsDomain;
var appServiceUserId;
var stripHtmlTags = /(<([^>]+)>)/ig;

var actionToMsgtypes = {
    message: "m.text",
    emote: "m.emote",
    notice: "m.notice"
};

var mkUserId = function(localpart) {
    return "@" + localpart + ":" + hsDomain;
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

module.exports.joinMappedRooms = function() {
    var d = q.defer();
    var promises = [];
    store.getRoomIdConfigs().done(function(roomIds) {
        var lib = module.exports.getMatrixLibFor();
        roomIds.forEach(function(roomId) {
            promises.push(lib.joinRoom(roomId));
        });
        q.allSettled(promises).then(function() {
            d.resolve();
        });
    });
    return d.promise;
};

module.exports.decodeMxc = function(mxcUri) {
    // looks like mxc://matrix.org/mxfsKGddpulqOiEVUcNcRUcb
    var client = sdk.getClientAs();
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
    return sdk.getClientAs(userId, (this.request ? this.request.id : null));
};

MatrixLib.prototype.addAlias = function(roomId, alias) {
    var defer = q.defer();
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
    var defer = q.defer();
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

/**
 * Create a room with the given alias.
 * @param {string} alias : The room alias to create (the localpart will be used).
 * @param {string=} name : The name of the room (optional).
 * @param {string=} topic : The topic for the room (optional).
 * @param {string=} joinRule : The join_rule for the room (optional).
 * @param {boolean=} publishRoom : True to publish this room on the public room list.
 * @return {Deferred} Which resolves to a {@link MatrixRoom}.
 */
MatrixLib.prototype.createRoomWithAlias = function(alias, name, topic, joinRule,
                                                   publishRoom) {
    var aliasLocalpart = getAliasLocalpart(alias);
    var client = this._getClient();
    var self = this;

    // The HS conflates join_rules and public rooms list visibility, so determine
    // if we need to set the join_rules after the room is made.
    var visibility = publishRoom ? "public" : "private";
    var joinRuleToSet = null;
    if (joinRule === "public" && visibility === "private") {
        joinRuleToSet = "public";
    }
    else if (joinRule === "invite" && visibility == "public") {
        // This doesn't make much sense, should we be allowing this?
        joinRuleToSet = "invite";
    }


    // if alias already used (M_UNKNOWN), query it and use that. Return a Room.
    return client.createRoom({
        room_alias_name: aliasLocalpart,
        name: name,
        topic: topic,
        visibility: visibility
    }).then(function(response) {
        var roomId = response.room_id;
        if (joinRuleToSet) {
            self.log.info(
                "Created room. Setting join_rules for %s to %s",
                alias, joinRuleToSet
            );

            // For new rooms we want to set the join_rules and
            // history_visibility state
            return setJoinRule(
              client, roomId, joinRuleToSet
            ).then(function(roomId) {
              return setRoomHistoryVisibility(client, roomId, "joined");
            });
        }
        else {
            return setRoomHistoryVisibility(client, roomId, "joined");
        }
    }, function(err) {
        if (err.errcode === "M_UNKNOWN") {
            // alias already taken, must be us. Join the room alias.
            return client.joinRoom(alias, {syncRoom: false}).then(function(r) {
                return r.roomId;
            });
        }
        else {
            throw "Failed to create room: " + JSON.stringify(err);
        }
    }).then(function(roomId) {
        return new MatrixRoom(roomId);
    });
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
        for (var i = 0; i < response.length; i++) {
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
    return q.reject("Unknown action: " + action.action);
};

MatrixLib.prototype.setInviteOnly = function(room, isInviteOnly) {
    var joinRule = isInviteOnly ? "invite" : "public";
    var client = this._getClient();
    var defer = q.defer();
    setJoinRule(client, room.roomId, joinRule).done(function() {
        defer.resolve({});
    }, function(e) {
         defer.reject(
            "Failed to set join_rules on room: %s",
            JSON.stringify(e)
        );
    });
    return defer.promise;
};

MatrixLib.prototype.joinRoom = function(roomId, matrixUser) {
    // client is the specified matrix user or the bot if a matrix user isn't
    // specified.
    var opts = {syncRoom: false};
    var lib = this;
    var defer = q.defer();
    var client = matrixUser ? lib._getClient(matrixUser.userId) : lib._getClient();
    client.joinRoom(roomId, opts).done(function(response) {
        defer.resolve(response);
    }, function(err) {
        if (err.errcode == "M_FORBIDDEN" && matrixUser) {
            // can the bot invite us? If so, join the send msg.
            var botClient = lib._getClient();
            botClient.invite(roomId, matrixUser.userId).done(function(r) {
                // now join.
                client.joinRoom(roomId, opts).done(function(response) {
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
                botClient.joinRoom(roomId, opts).then(function(response) {
                    return botClient.invite(roomId, matrixUser.userId);
                }).then(function(response) {
                    return client.joinRoom(roomId, opts);
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

MatrixLib.prototype.getDisplayName = function(roomId, userId) {
    var client = this._getClient();
    var defer = q.defer();
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

var setJoinRule = function(client, roomId, joinRule) {
    return client.sendStateEvent(
        roomId, "m.room.join_rules", {
            join_rule: joinRule
        }, ""
    ).then(function() {
        return roomId;
    });
};

var setRoomHistoryVisibility = function(client, roomId, history_visibility) {
    return client.sendStateEvent(
        roomId, "m.room.history_visibility", {
            "history_visibility": history_visibility
        }, ""
    ).then(function() {
        return roomId;
    });
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


var getMatrixUser = function(userLocalpart, displayName) {
    var defer = q.defer();
    var client = sdk.getClientAs();

    var createUserFn = function() {
        client.register(userLocalpart).done(function(response) {
            // user was create successfully
            var newUser = new MatrixUser(
                response.user_id, displayName, true
            );
            // set their display name
            var userClient = sdk.getClientAs(response.user_id);
            userClient.setDisplayName(displayName).done(function() {
                // persist in db and return user regardless of store outcome
                store.storeUser(newUser, userLocalpart, displayName, true).finally(
                function() {
                    defer.resolve(newUser);
                });
            }, function(e) {
                // non-fatal to not set the display name.
                // persist in db and return user regardless of store outcome
                store.storeUser(newUser, userLocalpart, displayName, false).finally(
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
                store.storeUser(newUser, userLocalpart, displayName, false).finally(
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
    store.getUser(userLocalpart).done(function(user) {
        if (user) {
            // excellent, return early.
            defer.resolve(user);
            return;
        }
        createUserFn();
    }, createUserFn);

    return defer.promise;
};

// IRC User -> Matrix User (Promise returned)
module.exports.ircToMatrixUser = function(user) {
    if (user.protocol !== "irc") {
        log.error("Bad src protocol: %s", user.protocol);
        return;
    }
    var userLocalpart = user.server.getUserLocalpart(user.nick);
    return getMatrixUser(userLocalpart, user.nick + " (IRC)");
};
