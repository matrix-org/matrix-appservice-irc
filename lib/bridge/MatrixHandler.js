/*eslint no-invalid-this: 0 consistent-return: 0*/
"use strict";
var Promise = require("bluebird");

var stats = require("../config/stats");
var MatrixRoom = require("matrix-appservice-bridge").MatrixRoom;
var IrcRoom = require("../models/IrcRoom");
var MatrixAction = require("../models/MatrixAction");
var IrcAction = require("../models/IrcAction");
var IrcClientConfig = require("../models/IrcClientConfig");
var MatrixUser = require("matrix-appservice-bridge").MatrixUser;
var BridgeRequest = require("../models/BridgeRequest");
var toIrcLowerCase = require("../irc/formatting").toIrcLowerCase;


function MatrixHandler(ircBridge) {
    this.ircBridge = ircBridge;
    // maintain a list of room IDs which are being processed invite-wise. This is
    // required because invites are processed asyncly, so you could get invite->msg
    // and the message is processed before the room is created.
    this._processingInvitesForRooms = {
        // roomId+userId: defer
    };
}

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
    yield this.ircBridge.getAppServiceBridge().getIntent().join(event.room_id);
    // clobber any previous admin room ID
    yield this.ircBridge.getStore().storeAdminRoom(mxRoom, inviter.userId);
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
    let mxUser = yield this.ircBridge.getMatrixUser(invitedIrcUser);
    yield this.ircBridge.getAppServiceBridge().getIntent(mxUser.getId()).join(event.room_id);
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

    // If no federated PMs are allowed, check the origin of the PM
    //  is same the domain as the bridge
    if (!invitedIrcUser.server.shouldFederatePMs()) {
        // Matches for the local part (the not-user part)
        var localpart = event.user_id.match(/[^:]*:(.*)/)[1];
        if (localpart !== this.ircBridge.domain) {
            req.log.error("Rejecting invite: This server does not allow federated PMs.");
            throw new Error("Server disallows federated PMs");
        }
        else {
            req.log.info("(PM federation)Invite not rejected: user on local HS");
        }
    }
    else {
        req.log.info("(PM federation)Invite not rejected: federated PMs allowed");
    }

    let mxRoom = new MatrixRoom(event.room_id);
    // create a virtual Matrix user for the IRC user
    let invitedUser = yield this.ircBridge.getMatrixUser(invitedIrcUser);
    yield this.ircBridge.getAppServiceBridge().getIntent(invitedUser.getId()).join(
        event.room_id
    );
    req.log.info("Joined %s to room %s", invitedUser.getId(), event.room_id);

    // check if this room is a PM room or not.
    let intent = this.ircBridge.getAppServiceBridge().getIntent(invitedUser.getId());
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
        yield this.ircBridge.getStore().setPmRoom(
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
    yield this.ircBridge.getAppServiceBridge().getIntent(invitedUser.getId()).leave(
        event.room_id
    );
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
                for (let i = 0; i < clientList.length; i++) {
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
            return BridgeRequest.ERR_VIRTUAL_USER;
        }

        // change the nick
        let bridgedClient = yield this.ircBridge.getBridgedClient(ircServer, event.user_id);
        try {
            let response = yield bridgedClient.changeNick(nick);
            let noticeRes = new MatrixAction("notice", response);
            yield this.ircBridge.sendMatrixAction(adminRoom, botUser, noticeRes, req);
            // persist this desired nick
            let config = yield this.ircBridge.getStore().getIrcClientConfig(
                event.user_id, ircServer.domain
            );
            if (!config) {
                config = IrcClientConfig.newConfig(
                    bridgedClient.matrixUser, ircServer.domain, nick
                );
            }
            config.setDesiredNick(nick);
            yield this.ircBridge.getStore().storeIrcClientConfig(config);
            return;
        }
        catch (err) {
            if (err.stack) {
                req.log.error(err);
            }
            let noticeErr = new MatrixAction("notice", err.message);
            yield this.ircBridge.sendMatrixAction(adminRoom, botUser, noticeErr, req);
            return;
        }
    }
    else if (cmd === "!join") {
        // TODO: Code dupe from !nick
        // Format is: "!join irc.example.com #channel [key]"

        // check that the server exists and that the user_id is on the whitelist
        let ircChannel = args[0];
        let key = args[1]; // keys can't have spaces in them, so we can just do this.
        let errText = null;
        if (!ircChannel || ircChannel.indexOf("#") !== 0) {
            errText = "Format: '!join irc.example.com #channel [key]'";
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

        // There are 2 main flows here:
        //   - The !join is instigated to make the BOT join a new channel.
        //        * Bot MUST join and invite user
        //   - The !join is instigated to make the USER join a new channel.
        //        * IRC User MAY have to join (if bridging incr joins or using a chan key)
        //        * Bot MAY invite user
        //
        // This means that in both cases:
        //  1) Bot joins IRC side (NOP if bot is disabled)
        //  2) Bot sends Matrix invite to bridged room. (ignore failures if already in room)
        // And *sometimes* we will:
        //  3) Force join the IRC user (if given key / bridging joins)

        // track the channel if we aren't already
        let matrixRooms = yield this.ircBridge.getStore().getMatrixRoomsForChannel(
            ircServer, ircChannel
        );

        if (matrixRooms.length === 0) {
            // track the channel then invite them.
            // TODO: Dupes onAliasQuery a lot
            let ircRoom = yield this.ircBridge.trackChannel(ircServer, ircChannel, key);
            let response = yield this.ircBridge.getAppServiceBridge().getIntent(
                event.user_id
            ).createRoom({
                options: {
                    name: ircChannel,
                    visibility: "private"
                    // Intent will automatically invite the user
                }
            });
            let mxRoom = new MatrixRoom(response.room_id);
            yield this.ircBridge.getStore().storeRoom(
                ircRoom, mxRoom
            );
            req.log.info(
                "Created a room to track %s on %s and invited %s",
                ircRoom.channel, ircServer.domain, event.user_id
            );
            matrixRooms.push(mxRoom);
        }

        // already tracking channel, so just invite them.
        let invitePromises = matrixRooms.map((room) => {
            req.log.info(
                "Inviting %s to room %s", event.user_id, room.getId()
            );
            return this.ircBridge.getAppServiceBridge().getIntent().invite(
                room.getId(), event.user_id
            );
        });

        // check whether we should be force joining the IRC user
        for (let i = 0; i < matrixRooms.length; i++) {
            let m = matrixRooms[i];
            let userMustJoin = (
                key || ircServer.shouldSyncMembershipToIrc("incremental", m.getId())
            );
            if (userMustJoin) {
                // force join then break out (we only ever join once no matter how many
                // rooms the channel is bridged to)
                let bc = yield this.ircBridge.getBridgedClient(
                    ircServer, event.user_id
                );
                yield bc.joinChannel(ircChannel, key);
                break;
            }
        }

        yield Promise.all(invitePromises);
    }
    else if (cmd === "!whois") {
        // Format is: "!whois <nick>"

        let whoisNick = args.length === 1 ? args[0] : null; // ensure 1 arg
        if (!whoisNick) {
            yield this.ircBridge.sendMatrixAction(
                adminRoom, botUser,
                new MatrixAction("notice", "Format: '!whois nick'"), req
            );
            return;
        }

        req.log.info("%s wants whois info on %s on %s", event.user_id,
            whoisNick, ircServer.domain);
        let bridgedClient = yield this.ircBridge.getBridgedClient(ircServer, event.user_id);
        try {
            let response = yield bridgedClient.whois(whoisNick);
            let noticeRes = new MatrixAction("notice", response.msg);
            yield this.ircBridge.sendMatrixAction(adminRoom, botUser, noticeRes, req);
        }
        catch (err) {
            if (err.stack) {
                req.log.error(err);
            }
            let noticeErr = new MatrixAction("notice", err.message);
            yield this.ircBridge.sendMatrixAction(adminRoom, botUser, noticeErr, req);
        }
        return;
    }
    else if (cmd === "!help") {
        let notice = new MatrixAction("notice",
            `Valid commands:
            !join irc.example.com #channel [key]
            !nick irc.example.com DesiredNick
            !whois nick`
        );
        yield this.ircBridge.sendMatrixAction(adminRoom, botUser, notice, req);
        return;
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
     * [2] bot --invite--> VMX  (invite-only room that the bot is in who is inviting virtuals)
     * [3] MX  --invite--> BOT  (admin room; auth)
     * [4] bot --invite--> MX   (bot telling real mx user IRC conn state)
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
        // failed to map invitee to an IRC user, is the inviter the bot?
        else if (this.ircBridge.getAppServiceUserId() === event.user_id) {
            // case [4] - ignore.
            return;
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
        return BridgeRequest.ERR_VIRTUAL_USER;
    }

    // is this a tracked channel?
    let ircRooms = yield this.ircBridge.getStore().getIrcChannelsForRoomId(event.room_id);

    // =========== Bridge Bot Joining ===========
    // Make sure the bot is joining on all mapped IRC channels
    ircRooms.forEach((ircRoom) => {
        this.ircBridge.joinBot(ircRoom);
    });

    // =========== Client Joining ===========
    // filter out rooms which don't mirror matrix join parts and are NOT frontier
    // entries. Frontier entries must ALWAYS be joined else the IRC channel will
    // not be bridged!
    ircRooms = ircRooms.filter(function(room) {
        return room.server.shouldSyncMembershipToIrc(
            syncKind, event.room_id
        ) || event._frontier;
    });

    if (ircRooms.length === 0) {
        req.log.info(
            "No tracked channels which mirror joins for this room."
        );
        return BridgeRequest.ERR_NOT_MAPPED;
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
            let bridgedClient = yield self.ircBridge.getBridgedClient(
                room.server, user.getId(), (event.content || {}).displayname
            );
            yield bridgedClient.joinChannel(room.channel); // join each channel
        })());
    });

    // We know ircRooms.length > 1. The only time when this isn't mapped into a Promise
    // is when there is a virtual user: TODO: clean this up! Control flow is hard.
    if (promises.length === 0) {
        return BridgeRequest.ERR_VIRTUAL_USER;
    }

    stats.membership(false, "join");
    yield Promise.all(promises);
});

MatrixHandler.prototype._onKick = Promise.coroutine(function*(req, event, kicker, kickee) {
    req.log.info(
        "onKick %s is kicking/banning %s from %s",
        kicker.getId(), kickee.getId(), event.room_id
    );

    /*
    We know this is a Matrix client kicking someone.
    There are 2 scenarios to consider here:
      - Matrix on Matrix kicking
      - Matrix on IRC kicking

    Matrix-Matrix
    =============
      __USER A____            ____USER B___
     |            |          |             |
    Matrix     vIRC1       Matrix        vIRC2 |     Effect
    -----------------------------------------------------------------------
    Kicker                 Kickee              |  vIRC2 parts channel.
                                                  This avoids potential permission issues
                                                  in case vIRC1 cannot kick vIRC2 on IRC.

    Matrix-IRC
    ==========
      __USER A____            ____USER B___
     |            |          |             |
    Matrix      vIRC        IRC       vMatrix  |     Effect
    -----------------------------------------------------------------------
    Kicker                            Kickee   |  vIRC tries to kick IRC via KICK command.
    */

    let ircRooms = yield this.ircBridge.getStore().getIrcChannelsForRoomId(event.room_id);
    // do we have an active connection for the kickee? This tells us if they are real
    // or virtual.
    let kickeeClients = this.ircBridge.getBridgedClientsForUserId(kickee.getId());

    if (kickeeClients.length === 0) {
        // Matrix on IRC kicking, work out which IRC user to kick.
        let server = null;
        for (let i = 0; i < ircRooms.length; i++) {
            if (ircRooms[i].server.claimsUserId(kickee.getId())) {
                server = ircRooms[i].server;
                break;
            }
        }
        if (!server) {
            return; // kicking a bogus user
        }
        let kickeeNick = server.getNickFromUserId(kickee.getId());
        if (!kickeeNick) {
            return; // bogus virtual user ID
        }
        // work out which client will do the kicking
        let kickerClient = this.ircBridge.getIrcUserFromCache(server, kicker.getId());
        if (!kickerClient) {
            // well this is awkward.. whine about it and bail.
            req.log.error(
                "%s has no client instance to send kick from. Cannot kick.",
                kicker.getId()
            );
            return;
        }
        // we may be bridging this matrix room into many different IRC channels, and we want
        // to kick this user from all of them.
        for (let i = 0; i < ircRooms.length; i++) {
            if (ircRooms[i].server.domain !== server.domain) {
                return;
            }
            kickerClient.kick(
                kickeeNick, ircRooms[i].channel,
                `Kicked by ${kicker.getId()}` +
                (event.content.reason ? ` : ${event.content.reason}` : "")
            );
        }
    }
    else {
        // Matrix on Matrix kicking: part the channel.
        let kickeeServerLookup = {};
        kickeeClients.forEach(function(ircClient) {
            kickeeServerLookup[ircClient.server.domain] = ircClient;
        });
        let promises = []; // one for each leave
        ircRooms.forEach(function(ircRoom) {
            // Make the connected IRC client leave the channel.
            let client = kickeeServerLookup[ircRoom.server.domain];
            if (!client) {
                return; // not connected to this server
            }
            // If we aren't joined this will no-op.
            promises.push(client.leaveChannel(
                ircRoom.channel, `Kicked by ${kicker.getId()}`
            ));
        });
        yield Promise.all(promises);
    }
});

MatrixHandler.prototype._onLeave = Promise.coroutine(function*(req, event, user, sender) {
    req.log.info("onLeave: %s", JSON.stringify(event));
    // membershiplists injects leave events when syncing initial membership
    // lists. We know if this event is injected because this flag is set.
    let syncKind = event._injected ? "initial" : "incremental";

    if (this.ircBridge.getAppServiceUserId() === user.getId()) {
        // ignore messages from the bot
        return BridgeRequest.ERR_VIRTUAL_USER;
    }

    // do we have an active connection for this user?
    let clientList = this.ircBridge.getBridgedClientsForUserId(user.getId());
    // filter out servers which don't mirror matrix join parts (unless it's a kick)
    clientList = clientList.filter(function(client) {
        return (
            client.server.shouldSyncMembershipToIrc(syncKind, event.room_id) &&
            !client.server.claimsUserId(user.getId())
        ); // not a virtual user
    });

    let serverLookup = {};
    clientList.forEach(function(ircClient) {
        serverLookup[ircClient.server.domain] = ircClient;
    });


    // which channels should the connected client leave?
    let ircRooms = yield this.ircBridge.getStore().getIrcChannelsForRoomId(event.room_id);

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

    if (promises.length === 0) { // no connected clients
        return BridgeRequest.ERR_VIRTUAL_USER;
    }

    // =========== Bridge Bot Parting ===========
    // For membership list syncing only
    ircRooms.forEach((ircRoom) => {
        let client = serverLookup[ircRoom.server.domain];
        if (!client) {
            return; // no client left the room, so no need to recheck part room.
        }
        if (!ircRoom.server.shouldJoinChannelsIfNoUsers()) {
            if (ircRoom.server.domain) {
                // this = IrcBridge
                this.ircBridge.memberListSyncers[ircRoom.server.domain].checkBotPartRoom(
                    ircRoom, req
                );
            }
        }
    });
    stats.membership(false, "part");
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
        return BridgeRequest.ERR_VIRTUAL_USER;
    }

    let ircAction = IrcAction.fromMatrixAction(
        MatrixAction.fromEvent(
            this.ircBridge.getAppServiceBridge().getClientFactory().getClientAs(), event
        )
    );
    let ircRooms = yield this.ircBridge.getStore().getIrcChannelsForRoomId(event.room_id);

    if (ircRooms.length === 0) {
        // could be an Admin room, so check.
        let adminRoom = yield this.ircBridge.getStore().getAdminRoomById(event.room_id);
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
                    let res = yield self.ircBridge.getAppServiceBridge().getBot()
                    .getClient().getStateEvent(
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

                let wouldSend = ircUser.unsafeClient.wouldSend(ircRoom.channel, event.content.body);
                if (wouldSend.length > 0) {
                    // Too long - send a file to the HS

                    // Upload as a file and get back URI
                    try {
                        let result = yield self.ircBridge.sendMatrixPlaintextFile(event.content.body);
                        console.log(result);
                    }
                    catch (err) {
                        console.log(err.stack);
                    }

                } else {
                }
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

    // We know ircRooms.length > 1, and the only time when a promise is NOT made
    // is when it's a virtual user. TODO: Tidy up control flow here.
    if (promises.length === 0) {
        return BridgeRequest.ERR_VIRTUAL_USER;
    }

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
    let matrixRooms = yield this.ircBridge.getStore().getMatrixRoomsForChannel(
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
        let botIntent = this.ircBridge.getAppServiceBridge().getIntent();
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
                newRoomId = room.getId();
            }
            else {
                req.log.error("Failed to create room: %s", e.stack);
                throw e;
            }
        }

        let matrixRoom = new MatrixRoom(newRoomId);
        req.log.info("Matrix room %s created.", matrixRoom.getId());

        // TODO set topic, add matrix members f.e. irc user(?) given
        // they are cheap to do.

        // ========= store the mapping and return OK
        let ircRoom = new IrcRoom(channelInfo.server, channelInfo.channel);
        yield this.ircBridge.getStore().storeRoom(ircRoom, matrixRoom);
    }
    else {
        // create an alias pointing to this room (take first)
        // TODO: Take first with public join_rules
        let roomId = matrixRooms[0].getId();
        req.log.info("Pointing alias %s to %s", roomAlias, roomId);
        yield this.ircBridge.getAppServiceBridge().getBot().getClient().createAlias(
            roomAlias, roomId
        );
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
    yield this.ircBridge.getMatrixUser(ircUser);
});

// EXPORTS

MatrixHandler.prototype.onInvite = function(req, event, inviter, invitee) {
    return reqHandler(req, this._onInvite(req, event, inviter, invitee));
};

MatrixHandler.prototype.onJoin = function(req, event, user) {
    return reqHandler(req, this._onJoin(req, event, user));
};

MatrixHandler.prototype.onLeave = function(req, event, user, sender) {
    return reqHandler(req, this._onLeave(req, event, user, sender));
};

MatrixHandler.prototype.onKick = function(req, event, kicker, kickee) {
    return reqHandler(req, this._onKick(req, event, kicker, kickee));
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
