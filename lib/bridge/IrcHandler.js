/*eslint no-invalid-this: 0 consistent-return: 0*/
"use strict";
var Promise = require("bluebird");

var stats = require("../config/stats");
var BridgeRequest = require("../models/BridgeRequest");
var IrcRoom = require("../models/IrcRoom");
var MatrixRoom = require("matrix-appservice-bridge").MatrixRoom;
var MatrixUser = require("matrix-appservice-bridge").MatrixUser;
var MatrixAction = require("../models/MatrixAction");

var Queue = require("../util/Queue.js");
var QuitDebouncer = require("./QuitDebouncer.js");

function IrcHandler(ircBridge) {
    this.ircBridge = ircBridge;
    // maintain a map of which user ID is in which PM room, so we know if we
    // need to re-invite them if they bail.
    this._roomIdToPrivateMember = {
        // room_id: { user_id: $USER_ID, membership: "join|invite|leave|etc" }
    };

    // Used when a server is configured to debounce quits that could potentially
    // be part of a net-split.
    this.quitDebouncer = new QuitDebouncer(ircBridge);

    // Use per-channel queues to keep the setting of topics in rooms atomic in
    // order to prevent races involving several topics being received from IRC
    // in quick succession. If `(server, channel, topic)` are the same, an
    // existing promise will be used, otherwise a new item is added to the queue.
    this.topicQueues = {
        //$channel : Queue
    }

    // A map of promises that resolve to the PM room that has been created for the
    // two users in the key. The $fromUserId is the user ID of the virtual IRC user
    // and the $toUserId, the user ID of the recipient of the message. This is used
    // to prevent races when many messages are sent as PMs at once and therefore
    // prevent many pm rooms from being created.
    this.pmRoomPromises = {
        //'$fromUserId $toUserId' : Promise
    };

    // Map<string,bool> which contains nicks we know have been registered/has display name
    this._registeredNicks = Object.create(null);
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
 * Create a new matrix PM room for an IRC user  with nick `fromUserNick` and another
 * matrix user with user ID `toUserId`.
 * @param {string} toUserId : The user ID of the recipient.
 * @param {string} fromUserId : The user ID of the sender.
 * @param {string} fromUserNick : The nick of the sender.
 * @param {IrcServer} server : The sending IRC server.
 * @return {Promise} which is resolved when the PM room has been created.
 */
IrcHandler.prototype._createPmRoom = Promise.coroutine(
    function*(toUserId, fromUserId, fromUserNick, server) {
        let response = yield this.ircBridge.getAppServiceBridge().getIntent(
            fromUserId
        ).createRoom({
            createAsClient: true,
            options: {
                name: (fromUserNick + " (PM on " + server.domain + ")"),
                visibility: "private",
                preset: "trusted_private_chat",
                invite: [toUserId],
                creation_content: {
                    "m.federate": server.shouldFederatePMs()
                }
            }
        });
        let pmRoom = new MatrixRoom(response.room_id);
        let ircRoom = new IrcRoom(server, fromUserNick);

        yield this.ircBridge.getStore().setPmRoom(
            ircRoom, pmRoom, toUserId, fromUserId
        );

        return pmRoom;
    }
);

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
    req.log.info("onPrivateMessage: %s from=%s to=%s action=%s",
        server.domain, fromUser, toUser,
        JSON.stringify(action).substring(0, 80)
    );

    if (bridgedIrcClient.isBot) {
        if (action.type !== "message") {
            req.log.info("Ignoring non-message PM");
            return;
        }
        req.log.debug("Rerouting PM directed to the bot from %s to provisioning", fromUser);
        this.ircBridge.getProvisioner().handlePm(server, fromUser, action.text);
        return;
    }


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
        let pmRoomPromiseId = bridgedIrcClient.userId + ' ' + virtualMatrixUser.getId();
        let p = this.pmRoomPromises[pmRoomPromiseId];

        // If a promise to create this PM room does not already exist, create one
        if (!p || p.isRejected()) {
            req.log.info("Creating a PM room with %s", bridgedIrcClient.userId);
            this.pmRoomPromises[pmRoomPromiseId] = this._createPmRoom(
                bridgedIrcClient.userId, virtualMatrixUser.getId(), fromUser.nick, server
            );
            p = this.pmRoomPromises[pmRoomPromiseId];
        }

        // Yield on the PM room being created
        pmRoom = yield p;
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
 * Called when the AS receives an IRC invite event.
 * @param {IrcServer} server : The sending IRC server.
 * @param {IrcUser} fromUser : The sender.
 * @param {IrcUser} toUser : The target.
 * @param {String} channel : The channel.
 * @return {Promise} which is resolved/rejected when the request
 * finishes.
 */
IrcHandler.prototype.onInvite = Promise.coroutine(function*(req, server, fromUser,
                                                              toUser, channel) {
    if (fromUser.isVirtual) {
        return BridgeRequest.ERR_VIRTUAL_USER;
    }

    if (!toUser.isVirtual) {
        req.log.error("Cannot route invite to %s", toUser);
        return;
    }

    let bridgedIrcClient = this.ircBridge.getClientPool().getBridgedClientByNick(
        toUser.server, toUser.nick
    );
    if (!bridgedIrcClient) {
        req.log.error("Cannot route invite to %s - no client", toUser);
        return;
    }

    if (bridgedIrcClient.isBot) {
        req.log.info("Ignoring invite send to the bot");
        return;
    }

    let virtualMatrixUser = yield this.ircBridge.getMatrixUser(fromUser);
    req.log.info("Mapped to %s", JSON.stringify(virtualMatrixUser));
    let matrixRooms = yield this.ircBridge.getStore().getMatrixRoomsForChannel(server, channel);
    let roomAlias = server.getAliasFromChannel(channel);

    if (matrixRooms.length === 0) {
        let ircRoom = yield this.ircBridge.trackChannel(server, channel, null);
        let response = yield this.ircBridge.getAppServiceBridge().getIntent(
            virtualMatrixUser.getId()
        ).createRoom({
            options: {
                room_alias_name: roomAlias.split(":")[0].substring(1), // localpart
                name: channel,
                visibility: "private",
                preset: "public_chat",
                creation_content: {
                    "m.federate": server.shouldFederate()
                },
                initial_state: [
                    {
                        type: "m.room.join_rules",
                        state_key: "",
                        content: {
                            join_rule: server.getJoinRule()
                        }
                    },
                    {
                        type: "m.room.history_visibility",
                        state_key: "",
                        content: {
                            history_visibility: "joined"
                        }
                    }
                ]
            }
        });

        // store the mapping
        let mxRoom = new MatrixRoom(response.room_id);
        yield this.ircBridge.getStore().storeRoom(
            ircRoom, mxRoom, 'join'
        );

        // /mode the channel AFTER we have created the mapping so we process +s and +i correctly.
        this.ircBridge.publicitySyncer.initModeForChannel(
            server, channel
        ).catch((err) => {
            req.log.error(
                "Could not init mode channel %s on %s",
                channel, server
            );
        });

        req.log.info(
            "Created a room to track %s on %s and invited %s",
            ircRoom.channel, server.domain, virtualMatrixUser.user_id
        );
        matrixRooms.push(mxRoom);
    }

    // send invite
    let invitePromises = matrixRooms.map((room) => {
        req.log.info(
            "Inviting %s to room %s", bridgedIrcClient.userId, room.getId()
        );
        return this.ircBridge.getAppServiceBridge().getIntent(
            virtualMatrixUser.getId()
        ).invite(
            room.getId(), bridgedIrcClient.userId
        );
    });
    yield Promise.all(invitePromises);
});

IrcHandler.prototype._serviceTopicQueue = Promise.coroutine(function*(item) {
    let promises = item.entries.map((entry) => {
        if (entry.matrix.topic === item.topic) {
            item.req.log.info(
                "Topic of %s already set to '%s'",
                entry.matrix.getId(),
                item.topic
            );
            return Promise.resolve();
        }
        return this.ircBridge.getAppServiceBridge().getIntent().setRoomTopic(
            entry.matrix.getId(),
            item.topic
        ).then(
            () => {
                entry.matrix.topic = item.topic;
                return this.ircBridge.getStore().upsertRoomStoreEntry(entry);
            },
            (err) => {
                item.req.log.error(`Error storing room ${entry.matrix.getId()} (${err.message})`);
            }
        );
    });
    try {
        yield Promise.all(promises);
        item.req.log.info(
            `Topic:  '${item.topic.substring(0, 20)}...' set in rooms: `,
            item.entries.map((entry) => entry.matrix.getId()).join(",")
        );
    }
    catch (err) {
        item.req.log.error(`Failed to set topic(s) ${err.message}`);
    }
});

/**
 * Called when the AS receives an IRC topic event.
 * @param {IrcServer} server : The sending IRC server.
 * @param {IrcUser} fromUser : The sender.
 * @param {string} channel : The target channel.
 * @param {Object} action : The IRC action performed.
 * @return {Promise} which is resolved/rejected when the request finishes.
 */
IrcHandler.prototype.onTopic = Promise.coroutine(function*(req, server, fromUser,
                                                    channel, action) {
    req.log.info("onTopic: %s from=%s to=%s action=%s",
        server.domain, fromUser, channel, JSON.stringify(action).substring(0, 80)
    );

    let topic = action.text;

    // Only bridge topics for rooms created by the bridge, via !join or an alias
    let origins = ["join", "alias"];
    let entries = yield this.ircBridge.getStore().getMappingsForChannelByOrigin(
        server, channel, origins, true
    );
    if (entries.length === 0) {
        req.log.info(
            "No mapped matrix rooms for IRC channel %s with origin = [%s]",
            channel,
            origins
        );
        return;
    }

    req.log.info(
        "New topic in %s - bot queing to set topic in %s",
        channel,
        entries.map((e) => e.matrix.getId())
    );
    if (!this.topicQueues[channel]) {
        this.topicQueues[channel] = new Queue(this._serviceTopicQueue.bind(this));
    }
    yield this.topicQueues[channel].enqueue(
        server.domain + " " + channel + " " + topic,
        {req: req, entries: entries, topic: topic}
    );
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

    const nickKey = server.domain + " " + fromUser.nick;
    let virtualMatrixUser;
    if (this._registeredNicks[nickKey]) {
        // save the database hit
        const sendingUserId = server.getUserIdFromNick(fromUser.nick);
        virtualMatrixUser = new MatrixUser(sendingUserId);
    }
    else {
        virtualMatrixUser = yield this.ircBridge.getMatrixUser(fromUser);
        this._registeredNicks[nickKey] = true;
    }

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

    this.quitDebouncer.onJoin(nick, server);

    // get virtual matrix user
    let matrixUser = yield this.ircBridge.getMatrixUser(joiningUser);
    let matrixRooms = yield this.ircBridge.getStore().getMatrixRoomsForChannel(server, chan);
    let promises = matrixRooms.map((room) => {
        req.log.info("Joining room %s and setting presence to online", room.getId());
        return Promise.all([
            this.ircBridge.getAppServiceBridge().getIntent(
                matrixUser.getId()
            ).join(room.getId()),
            this.ircBridge.getAppServiceBridge().getIntent(
                matrixUser.getId()
            ).client.setPresence("online")
        ]);
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
    Bot tries to kick user via /kick. If the kickee is an IRC user, we also make
    it leave the room, to be sure the member list is sync even if the kick failed.
    */

    let matrixRooms = yield this.ircBridge.getStore().getMatrixRoomsForChannel(server, chan);
    if (matrixRooms.length === 0) {
        req.log.info("No mapped matrix rooms for IRC channel %s", chan);
        return;
    }

    let userId;
    if (kickee.isVirtual) {
        let bridgedIrcClient = this.ircBridge.getClientPool().getBridgedClientByNick(
            server, kickee.nick
        );
        if (!bridgedIrcClient || bridgedIrcClient.isBot) {
            return; // unexpected given isVirtual == true, but meh, bail.
        }
        userId = bridgedIrcClient.userId;
    }
    else {
        let matrixUser = yield this.ircBridge.getMatrixUser(kickee);
        req.log.info("Mapped kickee nick %s to %s", kickee.nick, JSON.stringify(matrixUser));
        userId = matrixUser.getId();
    }

    let promises = matrixRooms.map((room) => {
        req.log.info("Kicking %s from room %s", userId, room.getId());
        return this.ircBridge.getAppServiceBridge().getIntent().kick(
            room.getId(), userId,
            `${kicker.nick} has kicked ${userId} from ${chan} (${reason})`
        );
    });
    yield Promise.all(promises);

    if (!kickee.isVirtual) {
        // security measure, the kick may have failed, so we make the user leave the room
        let promisesLeave = matrixRooms.map((room) => {
            req.log.info("Leaving (due to kick) room %s", room.getId());
            return this.ircBridge.getAppServiceBridge().getIntent(userId).leave(
                room.getId()
            );
        });
        yield Promise.all(promisesLeave);
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

    // Presence syncing and Quit Debouncing
    //  When an IRC user quits, debounce before leaving them from matrix rooms. In the meantime,
    //  update presence to "offline". If the user rejoins a channel before timeout, do not part
    //  user from the room. Otherwise timeout and leave rooms.
    if (kind === "quit" && server.shouldDebounceQuits()) {
        let shouldBridgePart = yield this.quitDebouncer.debounceQuit(req, server, matrixUser, nick);
        if (!shouldBridgePart) {
            return;
        }
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
    req.log.info(
        "onMode(%s) in %s by %s (arg=%s)",
        (enabled ? ("+" + mode) : ("-" + mode)),
        channel, by, arg
    );

    const privateModes = ["k", "i", "s"];
    if (privateModes.indexOf(mode) !== -1) {
        yield this._onPrivateMode(req, server, channel, by, mode, enabled, arg);
        return;
    }

    if (mode === "m") {
        yield this._onModeratedChannelToggle(req, server, channel, by, enabled, arg);
        return;
    }

    // Bridge usermodes to power levels
    let modeToPower = server.getModePowerMap();
    if (Object.keys(modeToPower).indexOf(mode) === -1) {
        // Not an operator power mode
        return;
    }

    const nick = arg;
    const matrixRooms = yield this.ircBridge.getStore().getMatrixRoomsForChannel(server, channel);
    if (matrixRooms.length === 0) {
        req.log.info("No mapped matrix rooms for IRC channel %s", channel);
        return;
    }

    // Work out what power levels to give
    const userPowers = [];
    if (modeToPower[mode] && enabled) { // only give this power if it's +, not -
        userPowers.push(modeToPower[mode]);
    }

    // Try to also add in other modes for this client connection
    const bridgedClient = this.ircBridge.getClientPool().getBridgedClientByNick(
        server, nick
    );
    let userId = null;
    if (bridgedClient) {
        userId = bridgedClient.userId;
        if (!bridgedClient.unsafeClient) {
            req.log.info(`Bridged client for ${nick} has no IRC client.`);
            return;
        }
        const chanData = bridgedClient.unsafeClient.chanData(channel);
        if (!(chanData && chanData.users)) {
            req.log.error(`No channel data for ${channel}`);
            return;
        }
        const userPrefixes = chanData.users[nick];

        userPrefixes.split('').forEach(
            prefix => {
                const m = bridgedClient.unsafeClient.modeForPrefix[prefix];
                if (modeToPower[m] !== undefined) {
                    userPowers.push(modeToPower[m]);
                }
            }
        );
    }
    else {
        // real IRC user, work out their user ID
        userId = server.getUserIdFromNick(nick);
    }

    // By default, unset the user's power level. This will be treated
    // as the users_default defined in the power levels (or 0 otherwise).
    let level = undefined;
    // Sort the userPowers for this user in descending order
    // and grab the highest value at the start of the array.
    if (userPowers.length > 0) {
        level = userPowers.sort((a, b) => b - a)[0];
    }

    req.log.info(
        `onMode: Mode ${mode} received for ${nick} - granting level of ${level} to ${userId}`
    );

    const promises = matrixRooms.map((room) => {
        return this.ircBridge.getAppServiceBridge().getIntent()
            .setPowerLevel(room.getId(), userId, level);
    });

    yield Promise.all(promises);
});

IrcHandler.prototype._onModeratedChannelToggle = Promise.coroutine(function*(req, server, channel,
                                                by, enabled, arg) {
    let matrixRooms = yield this.ircBridge.getStore().getMatrixRoomsForChannel(server, channel);
    // modify power levels for all mapped rooms to set events_default to something >0 so by default
    // people CANNOT speak into it (unless they are a mod or have voice, both of which need to be
    // configured correctly in the config file).
    const botClient = this.ircBridge.getAppServiceBridge().getIntent().getClient();
    for (let i = 0; i < matrixRooms.length; i++) {
        const roomId = matrixRooms[i].getId();
        try {
            const plContent = yield botClient.getStateEvent(roomId, "m.room.power_levels", "");
            plContent.events_default = enabled ? 1 : 0;
            yield botClient.sendStateEvent(roomId, "m.room.power_levels", plContent, "");
            req.log.info(
                "onModeratedChannelToggle: (channel=%s,enabled=%s) power levels updated in room %s",
                channel, enabled, roomId
            );
        }
        catch (err) {
            req.log.error("Failed to alter power level in room %s : %s", roomId, err);
        }
    }
});

IrcHandler.prototype._onPrivateMode = Promise.coroutine(function*(req, server, channel, by,
                                                mode, enabled, arg) {
    // 'k' = Channel requires 'keyword' to join.
    // 'i' = Channel is invite-only.
    // 's' = Channel is secret

    // For k and i, we currently want to flip the join_rules to be
    // 'invite' to prevent new people who are not in the room from
    // joining.

    // For s, we just want to control the room directory visibility
    // accordingly. (+s = 'private', -s = 'public')

    // TODO: Add support for specifying the correct 'keyword' and
    // support for sending INVITEs for virtual IRC users.
    let matrixRooms = yield this.ircBridge.getStore().getMatrixRoomsForChannel(server, channel);
    if (matrixRooms.length === 0) {
        req.log.info("No mapped matrix rooms for IRC channel %s", channel);
        return;
    }

    if (mode === "s") {
        if (!server.shouldPublishRooms()) {
            req.log.info("Not syncing publicity: shouldPublishRooms is false");
            return Promise.resolve();
        }
        const key = this.ircBridge.publicitySyncer.getIRCVisMapKey(server.getNetworkId(), channel);

        // Update the visibility for all rooms connected to this channel
        return this.ircBridge.publicitySyncer.updateVisibilityMap(
            true, key, enabled
        );
    }

    var promises = matrixRooms.map((room) => {
        switch (mode) {
            case "k":
            case "i":
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
            default:
                // Not reachable, but warn anyway in case of future additions
                log.warn(`onMode: Unhandled channel mode ${mode}`);
                return Promise.resolve();
        }
    });

    yield Promise.all(promises);
});

/**
 * Called when channel mode information is received
 * @param {Request} req The metadata request
 * @param {IrcServer} server : The sending IRC server.
 * @param {string} channel The channel that has the given mode.
 * @param {string} mode The mode that the channel is in, e.g. +sabcdef
 * @return {Promise} which is resolved/rejected when the request finishes.
 */
IrcHandler.prototype.onModeIs = Promise.coroutine(function*(req, server, channel, mode) {
    req.log.info(`onModeIs for ${channel} = ${mode}.`);

    // Delegate to this.onMode
    let promises = mode.split('').map(
        (modeChar) => {
            if (modeChar === '+') {
                return Promise.resolve();
            }
            return this.onMode(req, server, channel, 'onModeIs function', modeChar, true);
        }
    );

    // If the channel does not have 's' as part of its mode, trigger the equivalent of '-s'
    if (mode.indexOf('s') === -1) {
        promises.push(this.onMode(req, server, channel, 'onModeIs function', 's', false));
    }

    yield Promise.all(promises);
});

/**
 * Called when the AS connects/disconnects a Matrix user to IRC.
 * @param {Request} req The metadata request
 * @param {BridgedClient} client The client who is acting on behalf of the Matrix user.
 * @param {string} msg The message to share with the Matrix user.
 * @param {boolean} force True if ignoring startup suppresion.
 * @return {Promise} which is resolved/rejected when the request finishes.
 */
IrcHandler.prototype.onMetadata = Promise.coroutine(function*(req, client, msg, force) {
    req.log.info("%s : Sending metadata '%s'", client, msg);
    if (!this.ircBridge.isStartedUp() && !force) {
        req.log.info("Suppressing metadata: not started up.");
        return BridgeRequest.ERR_NOT_MAPPED;
    }
    let botUser = new MatrixUser(this.ircBridge.getAppServiceUserId());

    let adminRoom = yield this.ircBridge.getStore().getAdminRoomByUserId(client.userId);
    if (!adminRoom) {
        req.log.info("Creating an admin room with %s", client.userId);
        let response = yield this.ircBridge.getAppServiceBridge().getIntent().createRoom({
            createAsClient: false,
            options: {
                name: `${client.server.getReadableName()} IRC Bridge status`,
                topic:  `This room shows any errors or status messages from ` +
                        `${client.server.domain}, as well as letting you control ` +
                        "the connection. ",
                preset: "trusted_private_chat",
                visibility: "private",
                invite: [client.userId]
            }
        });
        adminRoom = new MatrixRoom(response.room_id);
        yield this.ircBridge.getStore().storeAdminRoom(adminRoom, client.userId);
        let newRoomMsg = `You've joined a Matrix room which is bridged to the IRC network ` +
                         `'${client.server.domain}', where you ` +
                         `are now connected as ${client.nick}. ` +
                         `This room shows any errors or status messages from IRC, as well as ` +
                         `letting you control the connection. Type !help for more information`

        let notice = new MatrixAction("notice", newRoomMsg);
        yield this.ircBridge.sendMatrixAction(adminRoom, botUser, notice, req);
    }

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
