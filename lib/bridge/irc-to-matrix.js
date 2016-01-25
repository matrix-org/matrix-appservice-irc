"use strict";
var Promise = require("bluebird");

var matrixLib = require("../mxlib/matrix");
var store = require("../store");

var pool = require("../irclib/client-pool");
var roomModels = require("../models/rooms");
var IrcRoom = roomModels.IrcRoom;
var actions = require("../models/actions");
var requests = require("../models/requests");

var logging = require("../logging");

/**
 * Called when the AS receives an IRC message event.
 * @param {IrcServer} server : The sending IRC server.
 * @param {IrcUser} fromUser : The sender.
 * @param {IrcUser} toUser : The target.
 * @param {Object} action : The IRC action performed.
 * @return {Promise} which is resolved/rejected when the request
 * finishes.
 */
module.exports.onPrivateMessage = Promise.coroutine(function*(req, server, fromUser, toUser, action) {
    if (fromUser.isVirtual) {
        throw new Error(requests.ERR_VIRTUAL_USER);
    }

    if (!toUser.isVirtual) {
        req.log.error("Cannot route PM to %s", toUser);
        return;
    }
    let bridgedIrcClient = pool.getBridgedClientByNick(
        toUser.server, toUser.nick
    );
    if (!bridgedIrcClient) {
        req.log.error("Cannot route PM to %s - no client", toUser);
        return;
    }
    if (bridgedIrcClient.isBot) {
        req.log.debug("Ignoring PM directed to the bot from %s", fromUser);
        return;
    }

    req.log.info("onPrivateMessage: %s from=%s to=%s action=%s",
        server.domain, fromUser, toUser,
        JSON.stringify(action).substring(0, 80)
    );

    if (!server.allowsPms()) {
        req.log.error("Server %s disallows PMs.", server.domain);
        return;
    }

    let mxAction = actions.toMatrix(action);

    if (!mxAction) {
        req.log.error("Couldn't map IRC action to matrix action");
        return;
    }

    let virtualMatrixUser = yield matrixLib.ircToMatrixUser(fromUser);
    req.log.info("Mapped to %s", JSON.stringify(virtualMatrixUser));
    let pmRoom = yield store.rooms.getMatrixPmRoom(
        bridgedIrcClient.userId, virtualMatrixUser.userId
    );

    if (!pmRoom) {
        // make a pm room then send the message
        req.log.info("Creating a PM room with %s", bridgedIrcClient.userId);
        pmRoom = yield req.mxLib.createRoomWithUser(
            virtualMatrixUser.userId, bridgedIrcClient.userId,
            (fromUser.nick + " (PM on " + server.domain + ")")
        );
        let ircRoom = new IrcRoom(server, fromUser.nick);
        yield store.rooms.setPmRoom(
            ircRoom, pmRoom, bridgedIrcClient.userId, virtualMatrixUser.userId
        );   
    }

    req.log.info("Relaying PM in room %s", pmRoom.roomId);
    yield req.mxLib.sendAction(pmRoom, virtualMatrixUser, mxAction)
});

/**
 * Called when the AS receives an IRC message event.
 * @param {IrcServer} server : The sending IRC server.
 * @param {IrcUser} fromUser : The sender.
 * @param {string} channel : The target channel.
 * @param {Object} action : The IRC action performed.
 * @return {Promise} which is resolved/rejected when the request finishes.
 */
module.exports.onMessage = Promise.coroutine(function*(req, server, fromUser, channel, action) {
    if (fromUser.isVirtual) {
        throw new Error(requests.ERR_VIRTUAL_USER);
    }

    req.log.info("ES6 onMessage: %s from=%s to=%s action=%s",
        server.domain, fromUser, channel, JSON.stringify(action).substring(0, 80)
    );

    let mxAction = actions.toMatrix(action);

    if (!mxAction) {
        req.log.error("Couldn't map IRC action to matrix action");
        return;
    }

    let virtualMatrixUser = yield matrixLib.ircToMatrixUser(fromUser);
    req.log.info("Mapped to %s", JSON.stringify(virtualMatrixUser));
    let matrixRooms = yield store.rooms.getMatrixRoomsForChannel(server, channel);
    let promises = [];
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
            channel
        );
    }
    yield Promise.all(promises);
});

/**
 * Called when the AS receives an IRC join event.
 * @param {IrcServer} server : The sending IRC server.
 * @param {IrcUser} joiningUser : The user who joined.
 * @param {string} chan : The channel that was joined.
 * @param {string} kind : The kind of join (e.g. from a member list if
 * the bot just connected, or an actual JOIN command)
 * @return {Promise} which is resolved/rejected when the request finishes.
 */
module.exports.onJoin = Promise.coroutine(function*(req, server, joiningUser, chan, kind) {
    let nick = joiningUser.nick;
    let syncType = kind === "names" ? "initial" : "incremental";
    if (!server.shouldSyncMembershipToMatrix(syncType, chan)) {
        req.log.info("IRC onJoin(%s) %s to %s - not syncing.", kind, nick, chan);
        throw new Error("Server doesn't mirror joins.");
    }

    req.log.info("onJoin(%s) %s to %s", kind, nick, chan);
    // if the person joining is a virtual IRC user, do nothing.
    if (joiningUser.isVirtual) {
        throw new Error(requests.ERR_VIRTUAL_USER);
    }
    // get virtual matrix user
    let matrixUser = yield matrixLib.ircToMatrixUser(joiningUser);
    req.log.info("Mapped nick %s to %s", nick, JSON.stringify(matrixUser));
    let matrixRooms = yield store.rooms.getMatrixRoomsForChannel(server, chan);
    let promises = [];
    matrixRooms.forEach(function(room) {
        req.log.info("Joining room %s", room.roomId);
        promises.push(req.mxLib.joinRoom(
            room.roomId, matrixUser
        ));
    });
    if (matrixRooms.length === 0) {
        req.log.info("No mapped matrix rooms for IRC channel %s", chan);
    }
    yield Promise.all(promises);
});

/**
 * Called when the AS receives an IRC part event.
 * @param {IrcServer} server : The sending IRC server.
 * @param {IrcUser} leavingUser : The user who parted.
 * @param {string} chan : The channel that was left.
 * @param {string} kind : The kind of part (e.g. PART, KICK, BAN,
 * netsplit, etc)
 * @return {Promise} which is resolved/rejected when the request finishes.
 */
module.exports.onPart = Promise.coroutine(function*(req, server, leavingUser, chan, kind) {
    // parts are always incremental (only NAMES are initial)
    if (!server.shouldSyncMembershipToMatrix("incremental", chan)) {
        req.log.info("Server doesn't mirror parts.");
        return;
    }
    let nick = leavingUser.nick;
    req.log.info("onPart(%s) %s to %s", kind, nick, chan);
    // if the person leaving is a virtual IRC user, do nothing.
    if (leavingUser.isVirtual) {
        throw new Error(requests.ERR_VIRTUAL_USER);
    }
    // get virtual matrix user
    let matrixUser = yield matrixLib.ircToMatrixUser(leavingUser);
    req.log.info("Mapped nick %s to %s", nick, JSON.stringify(matrixUser));
    let matrixRooms = yield store.rooms.getMatrixRoomsForChannel(server, chan);
    if (matrixRooms.length === 0) {
        req.log.info("No mapped matrix rooms for IRC channel %s", chan);
        return;
    }
    let promises = [];
    matrixRooms.forEach(function(room) {
        req.log.info("Leaving room %s", room.roomId);
        promises.push(req.mxLib.leaveRoom(
            matrixUser.userId, room.roomId
        ));
    });
    yield Promise.all(promises)
});

module.exports.onMode = Promise.coroutine(function*(req, server, channel, by, mode, enabled, arg) {
    if (["k", "i"].indexOf(mode) === -1) {
        return; // ignore everything but k and i
    }
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
        let matrixRooms = yield store.rooms.getMatrixRoomsForChannel(server, channel);
        if (matrixRooms.length === 0) {
            req.log.info("No mapped matrix rooms for IRC channel %s", channel);
            return;
        }
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
        
        yield Promise.all(promises);
    }
});
