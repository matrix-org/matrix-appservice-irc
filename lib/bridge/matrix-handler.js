/*eslint no-invalid-this: 0*/
"use strict";

var Promise = require("bluebird");
var promiseutil = require("../promiseutil");

var store = require("../store");

var roomModels = require("../models/rooms");
var MatrixRoom = roomModels.MatrixRoom;
var IrcRoom = roomModels.IrcRoom;
var MatrixAction = require("../models/MatrixAction");
var IrcAction = require("../models/IrcAction");
var MatrixUser = require("matrix-appservice-bridge").MatrixUser;
var BridgeRequest = require("../models/BridgeRequest");
var toIrcLowerCase = require("../irclib/formatting").toIrcLowerCase;

var logging = require("../logging");
var log = logging.get("matrix-to-irc");


function MatrixHandler(ircBridge) {
    this.ircBridge = ircBridge;
    // maintain a list of room IDs which are being processed invite-wise. This is
    // required because invites are processed asyncly, so you could get invite->msg
    // and the message is processed before the room is created.
    this._processingInvitesForRooms = {
        // roomId+userId: defer
    };
}

MatrixHandler.prototype._createMatrixUserForIrcUser = function(ircUser, req) {
    var defer = promiseutil.defer();

    /* TODO: Uncomment this when Synapse 0.9.3 comes out (fixes onUserQuery bug)
    req.ircLib.checkNickExists(ircUser.server, ircUser.nick).then(function(info) {
        req.log.info("Creating virtual user for %s on %s",
            ircUser.nick, ircUser.server.domain);
        return this.ircBridge.getMatrixUser(ircUser);
    }, function(err) {
        if (err.stack) {
            req.reject(err);
            return;
        }
        else {
            req.log.error(err);
            // still create a matrix user even if whois fails. This is to avoid
            // tons of onUserQuery spam (BOTS-39) whe mirroring join/parts.
            return this.ircBridge.getMatrixUser(ircUser);
        }
    }) */
    this.ircBridge.getMatrixUser(ircUser).then(function(user) {
        req.log.info("Created virtual user %s", user.getId());
        defer.resolve(user);
    }, function(err) {
        req.log.error("Virtual user creation for %s failed: %s",
            ircUser.nick, err);
        defer.reject(err);
    }).catch(log.logErr);

    return defer.promise;
};

// ===== Matrix Invite Handling =====

/**
 * Process a Matrix invite event for an Admin room.
 * @param {Object} event : The Matrix invite event.
 * @param {Request} req : The request for this event.
 * @param {MatrixUser} inviter : The user who invited the bot.
 * @param {MatrixUser} botUser : The bot itself.
 */
MatrixHandler.prototype._handleAdminRoomInvite = Promise.coroutine(function*(req, event,
                                                                    inviter, botUser) {
    req.log.info("Handling invite from user directed to bot.");
    // Real MX user inviting BOT to a private chat
    let mxRoom = new MatrixRoom(event.room_id);
    yield this.ircBridge.bridge.getIntent().join(event.room_id);
    // clobber any previous admin room ID
    yield store.rooms.storeAdminRoom(mxRoom, inviter.userId);
});

/**
 * Process a Matrix invite event for an Admin room.
 * @param {Object} event : The Matrix invite event.
 * @param {Request} req : The request for this event.
 * @param {IrcUser} invitedIrcUser : The IRC user the bot invited to a room.
 */
MatrixHandler.prototype._handleInviteFromBot = Promise.coroutine(function*(req, event,
                                                                 invitedIrcUser) {
    req.log.info("Handling invite from bot directed at %s on %s",
        invitedIrcUser.server.domain, invitedIrcUser.nick);
    // Bot inviting VMX to a matrix room which is mapped to IRC. Just make a
    // matrix user and join the room (we trust the bot, so no additional checks)
    let mxUser = yield this._createMatrixUserForIrcUser(invitedIrcUser, req);
    yield this.ircBridge.bridge.getIntent(mxUser.getId()).join(event.room_id);
});

MatrixHandler.prototype._handleInviteFromUser = Promise.coroutine(function*(req, event,
                                                                  invitedIrcUser) {
    req.log.info("Handling invite from user directed at %s on %s",
        invitedIrcUser.server.domain, invitedIrcUser.nick);

    // Real MX user inviting VMX to a matrix room for PM chat
    if (!invitedIrcUser.server.allowsPms()) {
        req.log.error("Rejecting invite: This server does not allow PMs.");
        throw new Error("Server disallows PMs");
    }
    let mxRoom = new MatrixRoom(event.room_id);
    // create a virtual Matrix user for the IRC user
    let invitedUser = yield this._createMatrixUserForIrcUser(invitedIrcUser, req);
    yield this.ircBridge.bridge.getIntent(invitedUser.getId()).join(event.room_id);
    req.log.info("Joined %s to room %s", invitedUser.getId(), event.room_id);

    // check if this room is a PM room or not.
    let intent = this.ircBridge.bridge.getIntent(invitedUser.getId());
    let roomState = yield intent.roomState(event.room_id);
    let joinedMembers = roomState.filter((ev) => {
        return ev.type === "m.room.member" && ev.content.membership === "join";
    }).map((ev) => ev.state_key);
    let isPmRoom = (
        joinedMembers.length === 2 && joinedMembers.indexOf(event.user_id) !== -1
    );

    if (isPmRoom) {
        // nick is the channel
        let ircRoom = new IrcRoom(
            invitedIrcUser.server, invitedIrcUser.nick
        );
        yield store.rooms.setPmRoom(
            ircRoom, mxRoom, event.user_id, event.state_key
        );
        return;
    }
    req.log.error("This room isn't a 1:1 chat!");
    // whine that you don't do group chats and leave.
    let notice = new MatrixAction("notice",
        "Group chat not supported."
    );
    try {
        yield this.ircBridge.sendMatrixAction(mxRoom, invitedUser, notice, req);
    }
    catch (err) {
        // ignore, we want to leave the room regardless.
    }
    yield this.ircBridge.bridge.getIntent(invitedUser.getId()).leave(event.room_id);
});


// === Admin room handling ===
MatrixHandler.prototype._onAdminMessage = Promise.coroutine(function*(req, event, adminRoom) {
    req.log.info("Received admin message from %s", event.user_id);
    let botUser = new MatrixUser(this.ircBridge.getAppServiceUserId());

    // Assumes all commands have the form "!cmd [irc.server] [args...]"
    let segments = event.content.body.split(" ");
    let cmd = segments.shift();
    let args = segments;

    // Work out which IRC server the command is directed at.
    let clientList = this.ircBridge.getBridgedClientsForUserId(event.user_id);
    let ircServer = this.ircBridge.getServer(args[0]);
    if (ircServer) {
        args.shift(); // pop the server so commands don't need to know
    }
    else {
        // default to the server the client is connected to if there is only one
        if (clientList.length === 1) {
            ircServer = clientList[0].server;
        }
        // default to the only server we know about if we only bridge 1 thing.
        else if (this.ircBridge.getServers().length === 1) {
            ircServer = this.ircBridge.getServers()[0];
        }
        else {
            let notice = new MatrixAction("notice",
                "A server address must be specified."
            );
            yield this.ircBridge.sendMatrixAction(adminRoom, botUser, notice, req);
            return;
        }
    }

    if (cmd === "!nick") {
        // Format is: "!nick irc.example.com NewNick"
        if (!ircServer.allowsNickChanges()) {
            let notice = new MatrixAction("notice",
                "Server " + ircServer.domain + " does not allow nick changes."
            );
            yield this.ircBridge.sendMatrixAction(adminRoom, botUser, notice, req);
            return;
        }

        let nick = args.length === 1 ? args[0] : null; // make sure they only gave 1 arg
        if (!ircServer || !nick) {
            let connectedNetworksStr = "";
            if (clientList.length === 0) {
                connectedNetworksStr = (
                    "You are not currently connected to any " +
                    "IRC networks which have nick changes enabled."
                );
            }
            else {
                connectedNetworksStr = "Currently connected to IRC networks:\n";
                for (var i = 0; i < clientList.length; i++) {
                    connectedNetworksStr += clientList[i].server.domain +
                        " as " + clientList[i].nick + "\n";
                }
            }
            let notice = new MatrixAction("notice",
                "Format: '!nick DesiredNick' or '!nick irc.server.name DesiredNick'\n" +
                connectedNetworksStr
            );
            yield this.ircBridge.sendMatrixAction(adminRoom, botUser, notice, req);
            return;
        }
        req.log.info("%s wants to change their nick on %s to %s",
            event.user_id, ircServer.domain, nick);

        if (ircServer.claimsUserId(event.user_id)) {
            req.log.error("%s is a virtual user!", event.user_id);
            throw new Error(BridgeRequest.ERR_VIRTUAL_USER);
        }

        // change the nick
        let bridgedClient = yield this.ircBridge.getBridgedClient(ircServer, event.user_id);
        try {
            let response = yield bridgedClient.changeNick(nick);
            let noticeRes = new MatrixAction("notice", response);
            yield this.ircBridge.sendMatrixAction(adminRoom, botUser, noticeRes, req);
            return;
        }
        catch (err) {
            if (err.stack) {
                req.log.error(err);
            }
            let noticeErr = new MatrixAction("notice", JSON.stringify(err));
            yield this.ircBridge.sendMatrixAction(adminRoom, botUser, noticeErr, req);
            return;
        }
    }
    else if (cmd === "!join") {
        // TODO: Code dupe from !nick
        // Format is: "!join irc.example.com #channel"

        // check that the server exists and that the user_id is on the whitelist
        let ircChannel = args.length === 1 ? args[0] : null; // ensure 1 arg
        let errText = null;
        if (!ircChannel || ircChannel.indexOf("#") !== 0) {
            errText = "Format: '!join irc.example.com #channel'";
        }
        else if (ircServer.hasInviteRooms() && !ircServer.isInWhitelist(event.user_id)) {
            errText = "You are not authorised to join channels on this server.";
        }

        if (errText) {
            yield this.ircBridge.sendMatrixAction(
                adminRoom, botUser, new MatrixAction("notice", errText), req
            );
            return;
        }

        req.log.info("%s wants to join the channel %s on %s", event.user_id,
            ircChannel, ircServer.domain);
        // track the channel if we aren't already
        let matrixRooms = yield store.rooms.getMatrixRoomsForChannel(ircServer, ircChannel);

        if (matrixRooms.length > 0) {
            // already tracking channel, so just invite them.
            let promises = matrixRooms.map((room) => {
                req.log.info(
                    "Inviting %s to room %s", event.user_id, room.roomId
                );
                return this.ircBridge.bridge.getIntent().invite(room.roomId, event.user_id);
            });
            yield Promise.all(promises);
            return;
        }
        // track the channel then invite them.
        // TODO: Dupes onAliasQuery a lot
        let ircRoom = yield this.ircBridge.trackChannel(ircServer, ircChannel);
        let response = yield this.ircBridge.bridge.getIntent(event.user_id).createRoom({
            options: {
                name: ircChannel,
                visibility: "private"
                // Intent will automatically invite the user
            }
        });
        yield store.rooms.set(ircRoom, new MatrixRoom(response.room_id));
        req.log.info(
            "Created a room to track %s on %s and invited %s",
            ircRoom.channel, ircServer.domain, event.user_id
        );
    }
    else {
        req.log.info("No valid admin command: %s", event.content.body);
    }
});

/**
 * Called when the AS receives a new Matrix invite event.
 * @param {Object} event : The Matrix invite event.
 * @param {MatrixUser} inviter : The inviter (sender).
 * @param {MatrixUser} invitee : The invitee (receiver).
 * @return {Promise} which is resolved/rejected when the request finishes.
 */
MatrixHandler.prototype._onInvite = Promise.coroutine(function*(req, event, inviter, invitee) {
    /*
     * (MX=Matrix user, VMX=Virtual matrix user, BOT=AS bot)
     * Valid invite flows:
     * [1] MX  --invite--> VMX  (starting a PM chat)
     * [2] bot --invite--> VMX  (invite-only room that the bot is in)
     * [3] MX  --invite--> BOT  (admin room; auth)
     */
    req.log.info("onInvite: %s", JSON.stringify(event));

    // mark this room as being processed in case we simultaneously get
    // messages for this room (which would fail if we haven't done the
    // invite yet!)
    this._processingInvitesForRooms[event.room_id + event.state_key] = req.getPromise();
    req.getPromise().finally(() => {
        delete this._processingInvitesForRooms[event.room_id + event.state_key];
    });

    // work out which flow we're dealing with and fork off asap
    // First, try to map the invitee to an IRC user.
    try {
        let ircUser = yield this.ircBridge.matrixToIrcUser(invitee);
        // the invitee does map to an IRC user: is the invite from the
        // bot?
        if (this.ircBridge.getAppServiceUserId() === event.user_id) {
            yield this._handleInviteFromBot(req, event, ircUser); // case [2]
        }
        else {
            yield this._handleInviteFromUser(req, event, ircUser); // case [1]
        }
    }
    catch (err) {
        // failed to map invitee to an IRC user; is the invitee the bot?
        if (this.ircBridge.getAppServiceUserId() === event.state_key) {
            // case [3]
            yield this._handleAdminRoomInvite(req, event, inviter, invitee);
        }
        else if (err && err.stack) { // syntax error possibly
            throw err;
        }
    }
});

MatrixHandler.prototype._onJoin = Promise.coroutine(function*(req, event, user) {
    let self = this;
    req.log.info("onJoin: %s", JSON.stringify(event));
    // membershiplists injects leave events when syncing initial membership
    // lists. We know if this event is injected because this flag is set.
    let syncKind = event._injected ? "initial" : "incremental";
    let promises = []; // one for each join request

    if (this.ircBridge.getAppServiceUserId() === user.getId()) {
        // ignore messages from the bot
        throw new Error(BridgeRequest.ERR_VIRTUAL_USER);
    }

    // is this a tracked channel?
    let ircRooms = yield store.rooms.getIrcChannelsForRoomId(event.room_id);

    // =========== Bridge Bot Joining ===========
    // Make sure the bot is joining on all mapped IRC channels
    ircRooms.forEach((ircRoom) => {
        this.ircBridge.joinBot(ircRoom);
    });

    // =========== Client Joining ===========
    // filter out rooms which don't mirror matrix join parts
    ircRooms = ircRooms.filter(function(room) {
        return room.server.shouldSyncMembershipToIrc(
            syncKind, event.room_id
        );
    });

    if (ircRooms.length === 0) {
        req.log.info(
            "No tracked channels which mirror joins for this room."
        );
        return;
    }

    // for each room (which may be on different servers)
    ircRooms.forEach(function(room) {
        if (room.server.claimsUserId(user.getId())) {
            req.log.info("%s is a virtual user (claimed by %s)",
                user.getId(), room.server.domain);
            return;
        }
        // get the virtual IRC user for this user
        promises.push(Promise.coroutine(function*() {
            let bridgedClient = yield self.ircBridge.getBridgedClient(room.server, user.getId());
            yield bridgedClient.joinChannel(room.channel); // join each channel
        })());
    });
    yield Promise.all(promises);
});

MatrixHandler.prototype._onLeave = Promise.coroutine(function*(req, event, user) {
    req.log.info("onLeave: %s", JSON.stringify(event));
    // membershiplists injects leave events when syncing initial membership
    // lists. We know if this event is injected because this flag is set.
    let syncKind = event._injected ? "initial" : "incremental";

    if (this.ircBridge.getAppServiceUserId() === user.getId()) {
        // ignore messages from the bot
        throw new Error(BridgeRequest.ERR_VIRTUAL_USER);
    }

    // do we have an active connection for this user?
    let clientList = this.ircBridge.getBridgedClientsForUserId(user.getId());
    // filter out servers which don't mirror matrix join parts
    clientList = clientList.filter(function(client) {
        return client.server.shouldSyncMembershipToIrc(syncKind, event.room_id) &&
            !client.server.claimsUserId(user.getId()); // not a virtual user
    });

    let serverLookup = {};
    clientList.forEach(function(ircClient) {
        serverLookup[ircClient.server.domain] = ircClient;
    });


    // which channels should the connected client leave?
    let ircRooms = yield store.rooms.getIrcChannelsForRoomId(event.room_id);

    let promises = []; // one for each leave request
    // ========== Client Parting ==========
    // for each room, if we're connected to it, leave the channel.
    ircRooms.forEach(function(ircRoom) {
        // Make the connected IRC client leave the channel.
        let client = serverLookup[ircRoom.server.domain];
        if (!client) {
            return; // not connected to this server
        }
        // leave it; if we aren't joined this will no-op.
        promises.push(client.leaveChannel(ircRoom.channel));
    });

    // =========== Bridge Bot Parting ===========
    // For membership list syncing only
    ircRooms.forEach((ircRoom) => {
        if (!ircRoom.server.shouldJoinChannelsIfNoUsers()) {
            if (ircRoom.server.domain) {
                // this = IrcBridge
                this.ircBridge.memberListSyncers[ircRoom.server.domain].checkBotPartRoom(
                    ircRoom, req
                );
            }
        }
    });

    yield Promise.all(promises);
});

/**
 * Called when the AS receives a new Matrix Event.
 * @param {Request} req
 * @param {Object} event : A Matrix event
 * @return {Promise} which is resolved/rejected when the request finishes.
 */
MatrixHandler.prototype._onMessage = Promise.coroutine(function*(req, event) {
    let self = this;
    /*
     * Valid message flows:
     * Matrix --> IRC (Bridged communication)
     * Matrix --> Matrix (Admin room)
     */

    req.log.info("%s usr=%s rm=%s body=%s",
        event.type, event.user_id, event.room_id,
        (event.content.body ? event.content.body.substring(0, 20) : "")
    );

    // wait a while if we just got an invite else we may not have the mapping stored
    // yet...
    if (this._processingInvitesForRooms[event.room_id + event.user_id]) {
        req.log.info(
            "Holding request for %s until invite for room %s is done.",
            event.user_id, event.room_id
        );
        yield this._processingInvitesForRooms[event.room_id + event.user_id];
        req.log.info(
            "Finished holding event for %s in room %s", event.user_id, event.room_id
        );
    }

    if (this.ircBridge.getAppServiceUserId() === event.user_id) {
        // ignore messages from the bot
        throw new Error(BridgeRequest.ERR_VIRTUAL_USER);
    }

    let ircAction = IrcAction.fromMatrixAction(
        MatrixAction.fromEvent(this.ircBridge.bridge.getClientFactory().getClientAs(), event)
    );
    let ircRooms = yield store.rooms.getIrcChannelsForRoomId(event.room_id);

    if (ircRooms.length === 0) {
        // could be an Admin room, so check.
        let adminRoom = yield store.rooms.getAdminRoomById(event.room_id);
        if (!adminRoom) {
            req.log.info("No mapped channels.");
            return;
        }
        // process admin request
        yield this._onAdminMessage(req, event, adminRoom);
        return;
    }

    let promises = [];

    ircRooms.forEach((ircRoom) => {
        if (ircRoom.server.claimsUserId(event.user_id)) {
            req.log.info("%s is a virtual user (claimed by %s)",
                event.user_id, ircRoom.server.domain);
            return;
        }
        req.log.info("Relaying message in %s on %s",
            ircRoom.channel, ircRoom.server.domain);

        // If we already have a cached client then yay, but if we
        // don't then we need to hit out for their display name in
        // this room.
        if (!this.ircBridge.getIrcUserFromCache(ircRoom.server, event.user_id)) {
            promises.push(Promise.coroutine(function*() {
                let displayName = undefined;
                try {
                    let res = yield self.ircBridge.bridge.getBot().getClient().getStateEvent(
                        event.room_id, "m.room.member", event.user_id
                    );
                    displayName = res.displayname;
                }
                catch (err) {
                    req.log.error("Failed to get display name: %s", err);
                    // this is non-fatal, continue.
                }
                let ircUser = yield self.ircBridge.getBridgedClient(
                    ircRoom.server, event.user_id, displayName
                );
                yield self.ircBridge.sendIrcAction(ircRoom, ircUser, ircAction);
            })());
        }
        else {
            // push each request so we don't block processing other rooms
            promises.push(Promise.coroutine(function*() {
                let ircUser = yield self.ircBridge.getBridgedClient(
                    ircRoom.server, event.user_id
                );
                yield self.ircBridge.sendIrcAction(
                    ircRoom, ircUser, ircAction
                );
            })());
        }
    });

    yield Promise.all(promises);
});

/**
 * Called when the AS receives an alias query from the HS.
 * @param {string} roomAlias : The room alias queried.
 * @return {Promise} which is resolved/rejected when the request finishes.
 */
MatrixHandler.prototype._onAliasQuery = Promise.coroutine(function*(req, roomAlias) {
    req.log.info("onAliasQuery %s", roomAlias);

    // check if alias maps to a valid IRC server and channel
    let channelInfo = this.ircBridge.aliasToIrcChannel(roomAlias);
    if (!channelInfo.channel) {
        throw new Error("Unknown alias: " + roomAlias);  // bad alias
    }
    if (!channelInfo.server.createsPublicAliases()) {
        throw new Error("This server does not allow alias mappings.");
    }
    req.log.info("Mapped to %s on %s",
        channelInfo.channel, channelInfo.server.domain
    );

    // See if we are already tracking this channel (case-insensitive
    // channels but case-sensitive aliases)
    let matrixRooms = yield store.rooms.getMatrixRoomsForChannel(
        channelInfo.server, channelInfo.channel
    );

    if (matrixRooms.length === 0) {
        // ====== Track the IRC channel
        // lower case the name to join (there's a bug in the IRC lib
        // where the join callback never fires if you try to join
        // #WithCaps in channels :/)
        channelInfo.channel = toIrcLowerCase(channelInfo.channel);
        req.log.info("Going to track IRC channel %s", channelInfo.channel);
        // join the irc server + channel
        yield this.ircBridge.trackChannel(channelInfo.server, channelInfo.channel);
        req.log.info("Bot is now tracking IRC channel.");

        // ======== Create the Matrix room
        let newRoomId = null;
        let botIntent = this.ircBridge.bridge.getIntent();
        try { // make the matrix room
            let res = yield botIntent.createRoom({
                options: {
                    room_alias_name: roomAlias.split(":")[0].substring(1), // localpart
                    name: channelInfo.channel,
                    visibility: (
                        channelInfo.server.shouldPublishRooms() ? "public" : "private"
                    ),
                    creation_content: {
                        "m.federate": channelInfo.server.shouldFederate()
                    },
                    initial_state: [
                        {
                            type: "m.room.join_rules",
                            state_key: "",
                            content: {
                                join_rule: channelInfo.server.getJoinRule()
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
            newRoomId = res.room_id;
        }
        catch (e) {
            if (e && e.errorcode === "M_UNKNOWN") {
                // alias already taken, must be us. Join the room alias.
                let room = yield botIntent.join(alias);
                newRoomId = room.roomId;
            }
            else {
                req.log.error("Failed to create room: %s", e.stack);
                throw e;
            }
        }

        let matrixRoom = new MatrixRoom(newRoomId);
        req.log.info("Matrix room %s created.", matrixRoom.roomId);

        // TODO set topic, add matrix members f.e. irc user(?) given
        // they are cheap to do.

        // ========= store the mapping and return OK
        let ircRoom = new IrcRoom(channelInfo.server, channelInfo.channel);
        yield store.rooms.set(ircRoom, matrixRoom);
    }
    else {
        // create an alias pointing to this room (take first)
        // TODO: Take first with public join_rules
        let roomId = matrixRooms[0].roomId;
        req.log.info("Pointing alias %s to %s", roomAlias, roomId);
        yield this.ircBridge.bridge.getBot().getClient().createAlias(roomAlias, roomId);
    }
});

/**
 * Called when the AS receives a user query from the HS.
 * @param {string} userId : The user ID queried.
 * @return {Promise} which is resolved/rejected when the request finishes.
 */
MatrixHandler.prototype._onUserQuery = Promise.coroutine(function*(req, userId) {
    if (this.ircBridge.getAppServiceUserId() === userId) {
        return;
    }
    req.log.info("onUserQuery: %s", userId);
    let matrixUser = new MatrixUser(userId);
    let ircUser = yield this.ircBridge.matrixToIrcUser(matrixUser);
    yield this._createMatrixUserForIrcUser(ircUser, req);
});

// EXPORTS

MatrixHandler.prototype.onInvite = function(req, event, inviter, invitee) {
    return reqHandler(req, this._onInvite(req, event, inviter, invitee));
};

MatrixHandler.prototype.onJoin = function(req, event, user) {
    return reqHandler(req, this._onJoin(req, event, user));
};

MatrixHandler.prototype.onLeave = function(req, event, user) {
    return reqHandler(req, this._onLeave(req, event, user));
};

MatrixHandler.prototype.onMessage = function(req, event) {
    return reqHandler(req, this._onMessage(req, event));
};

MatrixHandler.prototype.onAliasQuery = function(req, alias) {
    return reqHandler(req, this._onAliasQuery(req, alias));
};

MatrixHandler.prototype.onUserQuery = function(req, userId) {
    return reqHandler(req, this._onUserQuery(req, userId))
};

function reqHandler(req, promise) {
    return promise.then(function(res) {
        req.resolve(res);
        return res;
    }, function(err) {
        req.reject(err);
        throw err;
    });
}

module.exports = MatrixHandler;
