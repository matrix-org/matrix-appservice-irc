/*eslint no-invalid-this: 0 consistent-return: 0*/
"use strict";
var Promise = require("bluebird");

var stats = require("../config/stats");
var BridgeRequest = require("../models/BridgeRequest");
var IrcRoom = require("../models/IrcRoom");
var MatrixRoom = require("matrix-appservice-bridge").MatrixRoom;
var MatrixUser = require("matrix-appservice-bridge").MatrixUser;
var MatrixAction = require("../models/MatrixAction");

function IrcHandler(ircBridge) {
    this.ircBridge = ircBridge;
    // maintain a map of which user ID is in which PM room, so we know if we
    // need to re-invite them if they bail.
    this._roomIdToPrivateMember = {
        // room_id: { user_id: $USER_ID, membership: "join|invite|leave|etc" }
    };
}

IrcHandler.prototype.onMatrixMemberEvent = function(event) {
    let priv = this._roomIdToPrivateMember[event.room_id];
    if (!priv) {
        // _roomIdToPrivateMember only starts tracking AFTER one private message
        // has been sent since the bridge started, so if we can't find it, no
        // messages have been sent so we can ignore it (since when we DO start
        // tracking we hit room state explicitly).
        return;
    }
    if (priv.user_id !== event.state_key) {
        return; // don't care about member changes for other users
    }

    priv.membership = event.content.membership;
};

IrcHandler.prototype._ensureMatrixUserJoined = Promise.coroutine(function*(roomId,
                                                                userId, virtUserId, log) {
    let priv = this._roomIdToPrivateMember[roomId];
    if (!priv) {
        // create a brand new entry for this user. Set them to not joined initially
        // since we'll be yielding in a moment and we assume not joined.
        priv = {
            user_id: userId,
            membership: "leave"
        };
        this._roomIdToPrivateMember[roomId] = priv;

        // query room state to see if the user is actually joined.
        log.info("Querying PM room state (%s) between %s and %s",
            roomId, userId, virtUserId);
        let cli = this.ircBridge.getAppServiceBridge().getClientFactory().getClientAs(
            virtUserId
        );
        let stateEvents = yield cli.roomState(roomId);
        for (let i = 0; i < stateEvents.length; i++) {
            if (stateEvents[i].type === "m.room.member" &&
                    stateEvents[i].state_key === userId) {
                priv.membership = stateEvents[i].content.membership;
                break;
            }
        }
    }

    // we should have the latest membership state now for this user (either we just
    // fetched it or it has been kept in sync via onMatrixMemberEvent calls)

    if (priv.membership !== "join" && priv.membership !== "invite") { // fix it!
        log.info("Inviting %s to the existing PM room with %s (current membership=%s)",
            userId, virtUserId, priv.membership);
        let cli = this.ircBridge.getAppServiceBridge().getClientFactory().getClientAs(
            virtUserId
        );
        yield cli.invite(roomId, userId);
        // this should also be echoed back to us via onMatrixMemberEvent but hey,
        // let's do this now as well.
        priv.membership = "invite";
    }
});

/**
 * Called when the AS receives an IRC message event.
 * @param {IrcServer} server : The sending IRC server.
 * @param {IrcUser} fromUser : The sender.
 * @param {IrcUser} toUser : The target.
 * @param {Object} action : The IRC action performed.
 * @return {Promise} which is resolved/rejected when the request
 * finishes.
 */
IrcHandler.prototype.onPrivateMessage = Promise.coroutine(function*(req, server, fromUser,
                                                              toUser, action) {
    if (fromUser.isVirtual) {
        return BridgeRequest.ERR_VIRTUAL_USER;
    }

    if (!toUser.isVirtual) {
        req.log.error("Cannot route PM to %s", toUser);
        return;
    }
    let bridgedIrcClient = this.ircBridge.getClientPool().getBridgedClientByNick(
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

    let mxAction = MatrixAction.fromIrcAction(action);

    if (!mxAction) {
        req.log.error("Couldn't map IRC action to matrix action");
        return;
    }

    let virtualMatrixUser = yield this.ircBridge.getMatrixUser(fromUser);
    req.log.info("Mapped to %s", JSON.stringify(virtualMatrixUser));
    let pmRoom = yield this.ircBridge.getStore().getMatrixPmRoom(
        bridgedIrcClient.userId, virtualMatrixUser.getId()
    );

    if (!pmRoom) {
        // make a pm room then send the message
        req.log.info("Creating a PM room with %s", bridgedIrcClient.userId);
        let response = yield this.ircBridge.getAppServiceBridge().getIntent(
            virtualMatrixUser.getId()
        ).createRoom({
            createAsClient: true,
            options: {
                name: (fromUser.nick + " (PM on " + server.domain + ")"),
                visibility: "private",
                invite: [bridgedIrcClient.userId],
                creation_content: {
                    "m.federate": server.shouldFederatePMs()
                }
            }
        });
        pmRoom = new MatrixRoom(response.room_id);
        let ircRoom = new IrcRoom(server, fromUser.nick);
        yield this.ircBridge.getStore().setPmRoom(
            ircRoom, pmRoom, bridgedIrcClient.userId, virtualMatrixUser.getId()
        );
    }
    else {
        // make sure that the matrix user is still in the room
        try {
            yield this._ensureMatrixUserJoined(
                pmRoom.getId(), bridgedIrcClient.userId, virtualMatrixUser.getId(), req.log
            );
        }
        catch (err) {
            // We still want to send the message into the room even if we can't check -
            // maybe the room state API has blown up.
            req.log.error(
                "Failed to ensure matrix user %s was joined to the existing PM room %s : %s",
                bridgedIrcClient.userId, pmRoom.getId(), err
            );
        }
    }

    req.log.info("Relaying PM in room %s", pmRoom.getId());
    yield this.ircBridge.sendMatrixAction(pmRoom, virtualMatrixUser, mxAction, req);
});

/**
 * Called when the AS receives an IRC message event.
 * @param {IrcServer} server : The sending IRC server.
 * @param {IrcUser} fromUser : The sender.
 * @param {string} channel : The target channel.
 * @param {Object} action : The IRC action performed.
 * @return {Promise} which is resolved/rejected when the request finishes.
 */
IrcHandler.prototype.onMessage = Promise.coroutine(function*(req, server, fromUser,
                                                    channel, action) {
    if (fromUser.isVirtual) {
        return BridgeRequest.ERR_VIRTUAL_USER;
    }

    req.log.info("onMessage: %s from=%s to=%s action=%s",
        server.domain, fromUser, channel, JSON.stringify(action).substring(0, 80)
    );

    let mxAction = MatrixAction.fromIrcAction(action);

    if (!mxAction) {
        req.log.error("Couldn't map IRC action to matrix action");
        return;
    }

    let virtualMatrixUser = yield this.ircBridge.getMatrixUser(fromUser);
    req.log.info("Mapped to %s", JSON.stringify(virtualMatrixUser));
    let matrixRooms = yield this.ircBridge.getStore().getMatrixRoomsForChannel(server, channel);
    let promises = matrixRooms.map((room) => {
        req.log.info(
            "Relaying in room %s", room.getId()
        );
        return this.ircBridge.sendMatrixAction(room, virtualMatrixUser, mxAction, req);
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
IrcHandler.prototype.onJoin = Promise.coroutine(function*(req, server, joiningUser, chan, kind) {
    let nick = joiningUser.nick;
    let syncType = kind === "names" ? "initial" : "incremental";
    if (!server.shouldSyncMembershipToMatrix(syncType, chan)) {
        req.log.info("IRC onJoin(%s) %s to %s - not syncing.", kind, nick, chan);
        return BridgeRequest.ERR_NOT_MAPPED;
    }

    req.log.info("onJoin(%s) %s to %s", kind, nick, chan);
    // if the person joining is a virtual IRC user, do nothing.
    if (joiningUser.isVirtual) {
        return BridgeRequest.ERR_VIRTUAL_USER;
    }
    // get virtual matrix user
    let matrixUser = yield this.ircBridge.getMatrixUser(joiningUser);
    req.log.info("Mapped nick %s to %s", nick, JSON.stringify(matrixUser));
    let matrixRooms = yield this.ircBridge.getStore().getMatrixRoomsForChannel(server, chan);
    let promises = matrixRooms.map((room) => {
        req.log.info("Joining room %s", room.getId());
        return this.ircBridge.getAppServiceBridge().getIntent(
            matrixUser.getId()
        ).join(room.getId());
    });
    if (matrixRooms.length === 0) {
        req.log.info("No mapped matrix rooms for IRC channel %s", chan);
    }
    else {
        stats.membership(true, "join");
    }
    yield Promise.all(promises);
});

IrcHandler.prototype.onKick = Promise.coroutine(function*(req, server,
                                                kicker, kickee, chan, reason) {
    req.log.info(
        "onKick(%s) %s is kicking %s from %s",
        server.domain, kicker.nick, kickee.nick, chan
    );

    /*
    We know this is an IRC client kicking someone.
    There are 2 scenarios to consider here:
     - IRC on IRC kicking
     - IRC on Matrix kicking

    IRC-IRC
    =======
      __USER A____            ____USER B___
     |            |          |             |
    IRC       vMatrix1       IRC      vMatrix2 |     Effect
    -----------------------------------------------------------------------
    Kicker                 Kickee              |  vMatrix2 leaves room.
                                                  This avoid potential permission issues
                                                  in case vMatrix1 cannot kick vMatrix2
                                                  on Matrix.

    IRC-Matrix
    ==========
      __USER A____            ____USER B___
     |            |          |             |
    Matrix      vIRC        IRC       vMatrix  |     Effect
    -----------------------------------------------------------------------
               Kickee      Kicker              |  Bot tries to kick Matrix user via /kick.
    */

    if (kickee.isVirtual) {
        // A real IRC user is kicking one of us - this is IRC on Matrix kicking.
        let matrixRooms = yield this.ircBridge.getStore().getMatrixRoomsForChannel(server, chan);
        if (matrixRooms.length === 0) {
            req.log.info("No mapped matrix rooms for IRC channel %s", chan);
            return;
        }
        let bridgedIrcClient = this.ircBridge.getClientPool().getBridgedClientByNick(
            server, kickee.nick
        );
        if (!bridgedIrcClient) {
            return; // unexpected given isVirtual == true, but meh, bail.
        }
        let promises = matrixRooms.map((room) => {
            req.log.info("Kicking %s from room %s", bridgedIrcClient.userId, room.getId());
            return this.ircBridge.getAppServiceBridge().getIntent().kick(
                room.getId(), bridgedIrcClient.userId,
                `${kicker.nick} has kicked ${bridgedIrcClient.userId} from ${chan} (${reason})`
            );
        });
        yield Promise.all(promises);
    }
    else {
        // the kickee is just some random IRC user, but we still need to bridge this as IRC
        // will NOT send a PART command. We equally cannot make a fake PART command and
        // reuse the same code path as we want to force this to go through, regardless of
        // whether incremental join/leave syncing is turned on.
        let matrixUser = yield this.ircBridge.getMatrixUser(kickee);
        req.log.info("Mapped kickee nick %s to %s", kickee.nick, JSON.stringify(matrixUser));
        let matrixRooms = yield this.ircBridge.getStore().getMatrixRoomsForChannel(server, chan);
        if (matrixRooms.length === 0) {
            req.log.info("No mapped matrix rooms for IRC channel %s", chan);
            return;
        }
        let promises = matrixRooms.map((room) => {
            req.log.info("Leaving (due to kick) room %s", room.getId());
            return this.ircBridge.getAppServiceBridge().getIntent(
                matrixUser.getId()
            ).leave(room.getId());
        });
        yield Promise.all(promises);
    }
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
IrcHandler.prototype.onPart = Promise.coroutine(function*(req, server, leavingUser, chan, kind) {
    // parts are always incremental (only NAMES are initial)
    if (!server.shouldSyncMembershipToMatrix("incremental", chan)) {
        req.log.info("Server doesn't mirror parts.");
        return;
    }
    let nick = leavingUser.nick;
    req.log.info("onPart(%s) %s to %s", kind, nick, chan);

    // if the person leaving is a virtual IRC user, do nothing.
    if (leavingUser.isVirtual) {
        return BridgeRequest.ERR_VIRTUAL_USER;
    }
    // get virtual matrix user
    let matrixUser = yield this.ircBridge.getMatrixUser(leavingUser);
    req.log.info("Mapped nick %s to %s", nick, JSON.stringify(matrixUser));
    let matrixRooms = yield this.ircBridge.getStore().getMatrixRoomsForChannel(server, chan);
    if (matrixRooms.length === 0) {
        req.log.info("No mapped matrix rooms for IRC channel %s", chan);
        return;
    }
    let promises = matrixRooms.map((room) => {
        req.log.info("Leaving room %s", room.getId());
        return this.ircBridge.getAppServiceBridge().getIntent(
            matrixUser.getId()
        ).leave(room.getId());
    });
    stats.membership(true, "part");
    yield Promise.all(promises);
});

IrcHandler.prototype.onMode = Promise.coroutine(function*(req, server, channel, by,
                                                mode, enabled, arg) {
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
        let matrixRooms = yield this.ircBridge.getStore().getMatrixRoomsForChannel(server, channel);
        if (matrixRooms.length === 0) {
            req.log.info("No mapped matrix rooms for IRC channel %s", channel);
            return;
        }

        var promises = matrixRooms.map((room) => {
            req.log.info((enabled ? "Locking room %s" :
                "Reverting %s back to default join_rule"),
                room.getId()
            );
            if (enabled) {
                return this._setMatrixRoomAsInviteOnly(room, true);
            }
            // don't "unlock"; the room may have been invite
            // only from the beginning.
            enabled = server.getJoinRule() === "invite";
            return this._setMatrixRoomAsInviteOnly(room, enabled);
        });

        yield Promise.all(promises);
    }
});

/**
 * Called when the AS connects/disconnects a Matrix user to IRC.
 * @param {Request} req The metadata request
 * @param {BridgedClient} client The client who is acting on behalf of the Matrix user.
 * @param {string} msg The message to share with the Matrix user.
 * @return {Promise} which is resolved/rejected when the request finishes.
 */
IrcHandler.prototype.onMetadata = Promise.coroutine(function*(req, client, msg) {
    req.log.info("%s : Sending metadata '%s'", client, msg);
    if (!this.ircBridge.isStartedUp()) {
        req.log.info("Suppressing metadata: not started up.");
        return;
    }
    let adminRoom = yield this.ircBridge.getStore().getAdminRoomByUserId(client.userId);
    if (!adminRoom) {
        req.log.info("Creating an admin room with %s", client.userId);
        let response = yield this.ircBridge.getAppServiceBridge().getIntent().createRoom({
            createAsClient: false,
            options: {
                name: "IRC Application Service",
                preset: "trusted_private_chat",
                visibility: "private",
                invite: [client.userId]
            }
        });
        adminRoom = new MatrixRoom(response.room_id);
        yield this.ircBridge.getStore().storeAdminRoom(adminRoom, client.userId);
    }
    let botUser = new MatrixUser(this.ircBridge.getAppServiceUserId());
    let notice = new MatrixAction("notice", msg);
    yield this.ircBridge.sendMatrixAction(adminRoom, botUser, notice, req);
});

IrcHandler.prototype._setMatrixRoomAsInviteOnly = function(room, isInviteOnly) {
    return this.ircBridge.getAppServiceBridge().getClientFactory().getClientAs().sendStateEvent(
        room.getId(), "m.room.join_rules", {
            join_rule: (isInviteOnly ? "invite" : "public")
        }, ""
    );
};

module.exports = IrcHandler;
