"use strict";
var q = require("q");

var matrixLib = require("../mxlib/matrix");
var store = require("../store");

var pool = require("../irclib/client-pool");
var roomModels = require("../models/rooms");
var IrcRoom = roomModels.IrcRoom;
var actions = require("../models/actions");
var requests = require("../models/requests");

var logging = require("../logging");
var log = logging.get("irc-to-matrix");

/**
 * Called when the AS receives an IRC message event.
 * @param {IrcServer} server : The sending IRC server.
 * @param {IrcUser} fromUser : The sender.
 * @param {IrcUser} toUser : The target.
 * @param {Object} action : The IRC action performed.
 * @return {Promise} which is resolved/rejected when the request
 * finishes.
 */
module.exports.onPrivateMessage = function(server, fromUser, toUser, action) {
    if (!toUser.isVirtual) {
        log.error("Cannot route PM to %s", toUser);
        return q.reject();
    }
    var bridgedIrcClient = pool.getBridgedClientByNick(
        toUser.server, toUser.nick
    );
    if (!bridgedIrcClient) {
        log.error("Cannot route PM to %s - no client", toUser);
        return q.reject();
    }
    /* type {Request} */
    var req = requests.newRequest(true);

    req.log.info("onPrivateMessage: %s from=%s to=%s action=%s",
        server.domain, fromUser, toUser,
        JSON.stringify(action).substring(0, 80)
    );

    var mxAction = actions.toMatrix(action);

    if (!mxAction) {
        req.log.error("Couldn't map IRC action to matrix action");
        return req.defer.promise;
    }

    var virtualMatrixUser; // sender

    // map the sending IRC user to a Matrix user
    matrixLib.ircToMatrixUser(fromUser).then(function(user) {
        virtualMatrixUser = user;
        req.log.info(
            "Mapped to %s", JSON.stringify(user)
        );
        if (!server.allowsPms()) {
            req.log.error(
                "Server %s disallows PMs.", server.domain
            );
            return;
        }
        store.rooms.getMatrixPmRoom(
            bridgedIrcClient.userId, virtualMatrixUser.userId
        ).done(function(pmRoom) {
            if (pmRoom) {
                req.log.info("Relaying PM in room %s",
                    pmRoom.roomId);
                req.mxLib.sendAction(
                    pmRoom, virtualMatrixUser, mxAction
                ).done(req.sucFn, req.errFn);
                return;
            }
            // make a pm room then send the message
            req.log.info("Creating a PM room with %s",
                bridgedIrcClient.userId);
            req.mxLib.createRoomWithUser(
                virtualMatrixUser.userId, bridgedIrcClient.userId,
                (fromUser.nick + " (PM on " + server.domain + ")")
            ).done(function(mxRoom) {
                // the nick is the channel
                var ircRoom = new IrcRoom(
                    server, fromUser.nick
                );
                store.rooms.setPmRoom(
                    ircRoom, mxRoom, bridgedIrcClient.userId,
                    virtualMatrixUser.userId
                ).then(function() {
                    return req.mxLib.sendAction(
                        mxRoom,
                        virtualMatrixUser,
                        mxAction
                    );
                }).done(req.sucFn, req.errFn);
            }, req.errFn);
        });
    }).catch(req.errFn);
    return req.defer.promise;
};

/**
 * Called when the AS receives an IRC message event.
 * @param {IrcServer} server : The sending IRC server.
 * @param {IrcUser} fromUser : The sender.
 * @param {IrcUser} toUser : The target, which may be a channel.
 * @param {Object} action : The IRC action performed.
 * @return {Promise} which is resolved/rejected when the request finishes.
 */
module.exports.onMessage = function(server, fromUser, toUser, action) {
    if (fromUser.isVirtual) {
        return q.reject(requests.ERR_VIRTUAL_USER);
    }

    if (toUser.isVirtual) {
        return module.exports.onPrivateMessage(
            server, fromUser, toUser, action
        );
    }

    /* type {Request} */
    var req = requests.newRequest(true);

    req.log.info("onMessage: %s from=%s to=%s action=%s",
        server.domain, fromUser, toUser,
        JSON.stringify(action).substring(0, 80)
    );

    var mxAction = actions.toMatrix(action);

    if (!mxAction) {
        req.log.error("Couldn't map IRC action to matrix action");
        return req.defer.promise;
    }

    var virtualMatrixUser; // sender
    // map the sending IRC user to a Matrix user
    matrixLib.ircToMatrixUser(fromUser).then(function(user) {
        virtualMatrixUser = user;
        req.log.info(
            "Mapped to %s", JSON.stringify(user)
        );
        // this is directed at a channel
        store.rooms.getMatrixRoomsForChannel(server, toUser.nick).then(
        function(matrixRooms) {
            var promises = [];
            matrixRooms.forEach(function(room) {
                req.log.info(
                    "Relaying in room %s", room.roomId
                );
                promises.push(req.mxLib.sendAction(
                    room, virtualMatrixUser, mxAction
                ));
            });
            if (matrixRooms.length === 0) {
                req.log.info(
                    "No mapped matrix rooms for IRC channel %s",
                    toUser.nick
                );
            }
            q.all(promises).done(req.sucFn, req.errFn);
        }).catch(req.errFn);
    }).catch(req.errFn);
    return req.defer.promise;
};

/**
 * Called when the AS receives an IRC join event.
 * @param {IrcServer} server : The sending IRC server.
 * @param {IrcUser} joiningUser : The user who joined.
 * @param {string} chan : The channel that was joined.
 * @param {string} kind : The kind of join (e.g. from a member list if
 * the bot just connected, or an actual JOIN command)
 * @return {Promise} which is resolved/rejected when the request finishes.
 */
module.exports.onJoin = function(server, joiningUser, chan, kind) {
    var nick = joiningUser.nick;
    var syncType = kind === "names" ? "initial" : "incremental";
    if (!server.shouldSyncMembershipToMatrix(syncType, chan)) {
        log.info("IRC onJoin(%s) %s to %s - not syncing.", kind, nick, chan);
        return q.reject("Server doesn't mirror joins.");
    }
    /* type {Request} */
    var req = requests.newRequest(true);

    req.log.info("onJoin(%s) %s to %s", kind, nick, chan);
    // if the person joining is a virtual IRC user, do nothing.
    if (joiningUser.isVirtual) {
        req.defer.reject(requests.ERR_VIRTUAL_USER);
        return req.defer.promise; // don't send stuff which were sent from bots
    }
    // get virtual matrix user
    var matrixUser;
    matrixLib.ircToMatrixUser(joiningUser).then(function(user) {
        req.log.info(
            "Mapped nick %s to %s", nick, JSON.stringify(user)
        );
        matrixUser = user;
        return store.rooms.getMatrixRoomsForChannel(server, chan);
    }).then(function(matrixRooms) {
        var promises = [];
        matrixRooms.forEach(function(room) {
            req.log.info(
                "Joining room %s", room.roomId
            );
            promises.push(req.mxLib.joinRoom(
                room.roomId, matrixUser
            ));
        });
        if (matrixRooms.length === 0) {
            req.log.info(
                "No mapped matrix rooms for IRC channel %s", chan
            );
        }
        q.all(promises).done(req.sucFn, req.errFn);
    }).catch(req.errFn);

    return req.defer.promise;
};

/**
 * Called when the AS receives an IRC part event.
 * @param {IrcServer} server : The sending IRC server.
 * @param {IrcUser} leavingUser : The user who parted.
 * @param {string} chan : The channel that was left.
 * @param {string} kind : The kind of part (e.g. PART, KICK, BAN,
 * netsplit, etc)
 * @return {Promise} which is resolved/rejected when the request finishes.
 */
module.exports.onPart = function(server, leavingUser, chan, kind) {
    // parts are always incremental (only NAMES are initial)
    if (!server.shouldSyncMembershipToMatrix("incremental", chan)) {
        return q.reject("Server doesn't mirror parts.");
    }
    /* type {Request} */
    var req = requests.newRequest(true);
    var nick = leavingUser.nick;
    req.log.info("onPart(%s) %s to %s", kind, nick, chan);
    // if the person leaving is a virtual IRC user, do nothing.
    if (leavingUser.isVirtual) {
        req.defer.reject(requests.ERR_VIRTUAL_USER);
        return req.defer.promise;
    }
    // get virtual matrix user
    var matrixUser;
    matrixLib.ircToMatrixUser(leavingUser).then(function(user) {
        req.log.info(
            "Mapped nick %s to %s", nick, JSON.stringify(user)
        );
        matrixUser = user;
        return store.rooms.getMatrixRoomsForChannel(server, chan);
    }).then(function(matrixRooms) {
        var promises = [];
        matrixRooms.forEach(function(room) {
            req.log.info(
                "Leaving room %s", room.roomId
            );
            promises.push(req.mxLib.leaveRoom(
                matrixUser.userId, room.roomId
            ));
        });
        if (matrixRooms.length === 0) {
            req.log.info(
                "No mapped matrix rooms for IRC channel %s", chan
            );
        }
        q.all(promises).done(req.sucFn, req.errFn);
    }).catch(req.errFn);

    return req.defer.promise;
};

module.exports.onMode = function(server, channel, by, mode, enabled, arg) {
    if (["k", "i"].indexOf(mode) === -1) {
        return; // ignore everything but k and i
    }
    var req = requests.newRequest(true);
    req.log.info(
        "onMode(%s) in %s by %s (arg=%s)",
        (enabled ? ("+" + mode) : ("-" + mode)),
        channel, by, arg
    );

    // redundant if statement currently but eases burden when adding
    // support for more modes
    if (["k", "i"].indexOf(mode) !== -1) {
        // 'k' = Channel requires 'keyword' to join.
        // 'i' = Channel is invite-only.
        // Both cases we currently want to flip the join_rules to be
        // 'invite' to prevent new people who are not in the room from
        // joining.
        // TODO: Add support for specifying the correct 'keyword' and
        // support for sending INVITEs for virtual IRC users.
        store.rooms.getMatrixRoomsForChannel(server, channel).then(
        function(matrixRooms) {
            var promises = [];
            matrixRooms.forEach(function(room) {
                req.log.info(
                    (enabled ? "Locking room %s" :
                    "Reverting %s back to default join_rule"),
                    room.roomId
                );
                if (enabled) {
                    promises.push(req.mxLib.setInviteOnly(
                        room, true
                    ));
                }
                else {
                    // don't "unlock"; the room may have been invite
                    // only from the beginning.
                    enabled = server.getJoinRule() === "invite";
                    promises.push(req.mxLib.setInviteOnly(
                        room, enabled
                    ));
                }

            });
            if (matrixRooms.length === 0) {
                req.log.info(
                    "No mapped matrix rooms for IRC channel %s", channel
                );
            }
            q.all(promises).done(req.sucFn, req.errFn);
        }).catch(req.errFn);
    }

    return req.defer.promise;
};
