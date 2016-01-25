"use strict";

var Promise = require("bluebird");
var promiseutil = require("../promiseutil");

var matrixLib = require("../mxlib/matrix");
var ircLib = require("../irclib/irc");
var membershiplists = require("./membershiplists");
var store = require("../store");

var roomModels = require("../models/rooms");
var MatrixRoom = roomModels.MatrixRoom;
var IrcRoom = roomModels.IrcRoom;
var actions = require("../models/actions");
var users = require("../models/users");
var MatrixUser = users.MatrixUser;
var requests = require("../models/requests");
var toIrcLowerCase = require("../irclib/formatting").toIrcLowerCase;

var logging = require("../logging");
var log = logging.get("matrix-to-irc");

var createMatrixUserForIrcUser = function(ircUser, req) {
    var defer = promiseutil.defer();

    /* TODO: Uncomment this when Synapse 0.9.3 comes out (fixes onUserQuery bug)
    req.ircLib.checkNickExists(ircUser.server, ircUser.nick).then(function(info) {
        req.log.info("Creating virtual user for %s on %s",
            ircUser.nick, ircUser.server.domain);
        return matrixLib.ircToMatrixUser(ircUser);
    }, function(err) {
        if (err.stack) {
            req.errFn(err);
            return;
        }
        else {
            req.log.error(err);
            // still create a matrix user even if whois fails. This is to avoid
            // tons of onUserQuery spam (BOTS-39) whe mirroring join/parts.
            return matrixLib.ircToMatrixUser(ircUser);
        }
    }) */
    matrixLib.ircToMatrixUser(ircUser).then(function(user) {
        req.log.info("Created virtual user %s", user.userId);
        defer.resolve(user);
    }, function(err) {
        req.log.error("Virtual user creation for %s failed: %s",
            ircUser.nick, err);
        defer.reject(err);
    }).catch(log.logErr);

    return defer.promise;
};

// maintain a list of room IDs which are being processed invite-wise. This is
// required because invites are processed asyncly, so you could get invite->msg
// and the message is processed before the room is created.
var processingInvitesForRooms = {
    // roomId+userId: defer
};

/**
 * Hold an event until an invite processing for this room is complete.
 * @param {Object} event : A Matrix event.
 * @param {Request} request : A request object.
 */
var holdEvent = function(event, request) {
    processingInvitesForRooms[event.room_id + event.user_id].finally(function() {
        request.log.info(
            "Finished holding event for %s in room %s", event.user_id, event.room_id
        );
        module.exports.hooks.matrix.onMessage(event, request);
    });
};

// ===== Matrix Invite Handling =====

/**
 * Process a Matrix invite event for an Admin room.
 * @param {Object} event : The Matrix invite event.
 * @param {Request} req : The request for this event.
 * @param {MatrixUser} inviter : The user who invited the bot.
 * @param {MatrixUser} botUser : The bot itself.
 */
var handleAdminRoomInvite = function(event, req, inviter, botUser) {
    req.log.info("Handling invite from user directed to bot.");
    // Real MX user inviting BOT to a private chat
    var mxRoom = new MatrixRoom(event.room_id);
    req.mxLib.joinRoom(event.room_id, botUser).then(function() {
        // clobber any previous admin room ID
        return store.rooms.storeAdminRoom(mxRoom, inviter.userId);
    }).done(req.sucFn, req.errFn);
};

/**
 * Process a Matrix invite event for an Admin room.
 * @param {Object} event : The Matrix invite event.
 * @param {Request} req : The request for this event.
 * @param {IrcUser} invitedIrcUser : The IRC user the bot invited to a room.
 */
var handleInviteFromBot = function(event, req, invitedIrcUser) {
    req.log.info("Handling invite from bot directed at %s on %s",
        invitedIrcUser.server.domain, invitedIrcUser.nick);
    // Bot inviting VMX to a matrix room which is mapped to IRC. Just make a
    // matrix user and join the room (we trust the bot, so no additional checks)
    createMatrixUserForIrcUser(invitedIrcUser, req).then(function(mxUser) {
        return req.mxLib.joinRoom(event.room_id, mxUser);
    }).done(req.sucFn, req.errFn);
};

var handleInviteFromUser = function(event, req, invitedIrcUser) {
    req.log.info("Handling invite from user directed at %s on %s",
        invitedIrcUser.server.domain, invitedIrcUser.nick);

    // Real MX user inviting VMX to a matrix room for PM chat
    if (!invitedIrcUser.server.allowsPms()) {
        req.log.error("Rejecting invite: This server does not allow PMs.");
        return Promise.reject(new Error("Server disallows PMs"));
    }
    // create a virtual Matrix user for the IRC user
    var invitedUser = null;
    createMatrixUserForIrcUser(invitedIrcUser, req).then(function(mxUser) {
        invitedUser = mxUser;
        return req.mxLib.joinRoom(event.room_id, invitedUser);
    }).then(function() {
        req.log.info("Joined %s to room %s", invitedUser.userId, event.room_id);
        return req.mxLib.isPmRoom(
            invitedUser.userId, event.room_id, event.user_id
        );
    }).then(function(isPmRoom) {
        var mxRoom = new MatrixRoom(event.room_id);
        if (isPmRoom) {
            // nick is the channel
            var ircRoom = new IrcRoom(
                invitedIrcUser.server, invitedIrcUser.nick
            );
            return store.rooms.setPmRoom(
                ircRoom, mxRoom, event.user_id, event.state_key
            );
        }
        else {
            req.log.error("This room isn't a 1:1 chat!");
            // whine that you don't do group chats and leave.
            var notice = actions.matrix.createNotice(
                "Group chat not supported."
            );
            req.mxLib.sendAction(mxRoom, invitedUser, notice).finally(function() {
                req.mxLib.leaveRoom(invitedUser.userId, event.room_id).done(
                    req.sucFn, req.errFn
                );
            });
        }
    }).done(req.sucFn, req.errFn);
};


// === Admin room handling ===
var onAdminMessage = function(event, req, adminRoom) {
    req.log.info("Received admin message from %s", event.user_id);
    var botUser = new MatrixUser(
        matrixLib.getAppServiceUserId(), null, false
    );
    var segments = event.content.body.split(" ");
    if (event.content.body.indexOf("!nick") === 0) {
        // Format is: "!nick irc.example.com NewNick"
        var clientList = ircLib.getBridgedClientsForUserId(event.user_id);
        var i = 0;
        // strip servers which don't allow nick changes
        for (i = 0; i < clientList.length; i++) {
            if (!clientList[i].server.allowsNickChanges()) {
                clientList.splice(i, 1);
                i--;
            }
        }
        var ircServer = null;
        for (i = 0; i < clientList.length; i++) {
            if (clientList[i].server.domain === segments[1]) {
                ircServer = clientList[i].server;
                break;
            }
        }
        var nick = segments[2];
        if (!ircServer || !nick) {
            var connectedNetworksStr = "";
            if (clientList.length === 0) {
                connectedNetworksStr = (
                    "You are not currently connected to any " +
                    "IRC networks which have nick changes enabled."
                );
            }
            else {
                connectedNetworksStr = "Currently connected to IRC networks:\n";
                for (i = 0; i < clientList.length; i++) {
                    connectedNetworksStr += clientList[i].server.domain +
                        " as " + clientList[i].nick + "\n";
                }
            }
            var notice = actions.matrix.createNotice(
                "Format: '!nick irc.example.com DesiredNick'\n" +
                connectedNetworksStr
            );
            req.mxLib.sendAction(adminRoom, botUser, notice).done(
                req.sucFn, req.errFn
            );
            return;
        }
        req.log.info("%s wants to change their nick on %s to %s",
            event.user_id, ircServer.domain, nick);

        if (ircServer.claimsUserId(event.user_id)) {
            req.log.error("%s is a virtual user!", event.user_id);
            req.defer.reject(new Error(requests.ERR_VIRTUAL_USER));
            return req.defer.promise;
        }

        // change the nick
        req.ircLib.getBridgedClient(ircServer, event.user_id).then(
        function(bridgedClient) {
            return bridgedClient.changeNick(nick);
        }).then(function(response) {
            var notice = actions.matrix.createNotice(response);
            return req.mxLib.sendAction(adminRoom, botUser, notice);
        }, function(err) {
            if (err.stack) {
                log.logErr(err);
            }
            var notice = actions.matrix.createNotice(JSON.stringify(err));
            return req.mxLib.sendAction(adminRoom, botUser, notice);
        }).done(req.sucFn, req.errFn);
    }
    else if (event.content.body.indexOf("!join") === 0) {
        // TODO: Code dupe from !nick
        // Format is: "!join irc.example.com #channel"

        // check that the server exists and that the user_id is on the whitelist
        var server = ircLib.getServer(segments[1]);
        var ircChannel = segments[2];
        var errText = null;
        if (!ircChannel || ircChannel.indexOf("#") !== 0) {
            errText = "Format: '!join irc.example.com #channel'";
        }
        else if (!server) {
            errText = "Unknown server.";
        }
        else if (server.hasInviteRooms() &&
                !server.isInWhitelist(event.user_id)) {
            errText = "You are not authorised to join channels on this server.";
        }
        if (errText) {
            req.mxLib.sendAction(
                adminRoom, botUser, actions.matrix.createNotice(errText)
            ).done(req.sucFn, req.errFn);
            return;
        }
        req.log.info("%s wants to join the channel %s on %s", event.user_id,
            ircChannel, server.domain);
        // track the channel if we aren't already
        store.rooms.getMatrixRoomsForChannel(server, ircChannel).done(
        function(matrixRooms) {
            if (matrixRooms.length > 0) {
                // already tracking channel, so just invite them.
                var promises = [];
                matrixRooms.forEach(function(room) {
                    req.log.info(
                        "Inviting %s to room %s", event.user_id, room.roomId
                    );
                    promises.push(req.mxLib.invite(room, event.user_id));
                });
                Promise.all(promises).done(req.sucFn, req.errFn);
            }
            else {
                // track the channel then invite them.
                // TODO: Dupes onAliasQuery a lot
                var ircRoom = null;
                ircLib.trackChannel(server, ircChannel).then(function(room) {
                    ircRoom = room;
                    // implied private
                    return req.mxLib.createRoomWithUser(
                        undefined, event.user_id, ircChannel
                    );
                }).then(function(mxRoom) {
                    return store.rooms.set(ircRoom, mxRoom);
                }).then(function() {
                    req.log.info(
                        "Created a room to track %s on %s and invited %s",
                        ircRoom.channel, server.domain, event.user_id
                    );
                    req.sucFn();
                }).catch(req.errFn);
            }
        }, req.errFn);
    }
    else {
        req.log.info("No valid admin command: %s", event.content.body);
        req.sucFn();
    }
};

/**
 * Called when the AS receives a new Matrix invite event.
 * @param {Object} event : The Matrix invite event.
 * @param {MatrixUser} inviter : The inviter (sender).
 * @param {MatrixUser} invitee : The invitee (receiver).
 * @return {Promise} which is resolved/rejected when the request finishes.
 */
module.exports.onInvite = function(event, inviter, invitee) {
    /*
     * (MX=Matrix user, VMX=Virtual matrix user, BOT=AS bot)
     * Valid invite flows:
     * [1] MX  --invite--> VMX  (starting a PM chat)
     * [2] bot --invite--> VMX  (invite-only room that the bot is in)
     * [3] MX  --invite--> BOT  (admin room; auth)
     */
    var req = requests.newRequest(false);
    req.log.info("onInvite: %s", JSON.stringify(event));

    // mark this room as being processed in case we simultaneously get
    // messages for this room (which would fail if we haven't done the
    // invite yet!)
    processingInvitesForRooms[
        event.room_id + event.state_key
    ] = req.defer.promise;
    req.defer.promise.finally(function() {
        processingInvitesForRooms[event.room_id + event.state_key] = undefined;
    });

    // work out which flow we're dealing with and fork off asap
    // First, try to map the invitee to an IRC user.
    ircLib.matrixToIrcUser(invitee).done(function(ircUser) {
        // the invitee does map to an IRC user: is the invite from the
        // bot?
        if (matrixLib.getAppServiceUserId() === event.user_id) {
            handleInviteFromBot(event, req, ircUser); // case [2]
        }
        else {
            handleInviteFromUser(event, req, ircUser); // case [1]
        }
    }, function(err) {
        // failed to map invitee to an IRC user; is the invitee the bot?
        if (matrixLib.getAppServiceUserId() === event.state_key) {
            // case [3]
            handleAdminRoomInvite(event, req, inviter, invitee);
        }
        else if (err && err.stack) {
            req.errFn(err);
        }
        else {
            // couldn't map to an IRC user; not a failure.
            req.sucFn();
        }
    });

    return req.defer.promise;
};

module.exports.onJoin = function(event, user) {
    var req = requests.newRequest(false);
    req.log.info("onJoin: %s", JSON.stringify(event));
    // membershiplists injects leave events when syncing initial membership
    // lists. We know if this event is injected because this flag is set.
    var syncKind = event._injected ? "initial" : "incremental";
    var promises = []; // one for each join request

    if (matrixLib.getAppServiceUserId() === user.userId) {
        // ignore messages from the bot
        req.defer.reject(new Error(requests.ERR_VIRTUAL_USER));
        return req.defer.promise;
    }

    // is this a tracked channel?
    store.rooms.getIrcChannelsForRoomId(event.room_id).done(
    function(ircRooms) {
        // =========== Bridge Bot Joining ===========
        // Make sure the bot is joining on all mapped IRC channels
        ircRooms.forEach(function(ircRoom) {
            req.ircLib.joinBot(ircRoom);
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
            req.sucFn();
            return;
        }

        // for each room (which may be on different servers)
        ircRooms.forEach(function(room) {
            if (room.server.claimsUserId(user.userId)) {
                req.log.info("%s is a virtual user (claimed by %s)",
                    user.userId, room.server.domain);
                return;
            }
            // get the virtual IRC user for this user
            promises.push(
                req.ircLib.getBridgedClient(room.server, user.userId).then(
                function(bridgedClient) {
                    // join each channel
                    return bridgedClient.joinChannel(room.channel);
                })
            );
        });
        Promise.all(promises).done(req.sucFn, req.errFn);
    }, req.errFn);
    return req.defer.promise;
};

module.exports.onLeave = function(event, user) {
    var req = requests.newRequest(false);
    req.log.info("onLeave: %s", JSON.stringify(event));
    // membershiplists injects leave events when syncing initial membership
    // lists. We know if this event is injected because this flag is set.
    var syncKind = event._injected ? "initial" : "incremental";

    if (matrixLib.getAppServiceUserId() === user.userId) {
        // ignore messages from the bot
        req.defer.reject(new Error(requests.ERR_VIRTUAL_USER));
        return req.defer.promise;
    }

    // do we have an active connection for this user?
    var clientList = ircLib.getBridgedClientsForUserId(user.userId);
    // filter out servers which don't mirror matrix join parts
    clientList = clientList.filter(function(client) {
        return client.server.shouldSyncMembershipToIrc(syncKind, event.room_id) &&
            !client.server.claimsUserId(user.userId); // not a virtual user
    });

    var serverLookup = {};
    clientList.forEach(function(ircClient) {
        serverLookup[ircClient.server.domain] = ircClient;
    });
    var promises = []; // one for each leave request

    // which channels should the connected client leave?
    store.rooms.getIrcChannelsForRoomId(event.room_id).done(
    function(ircRooms) {
        // ========== Client Parting ==========
        // for each room, if we're connected to it, leave the channel.
        ircRooms.forEach(function(ircRoom) {
            // Make the connected IRC client leave the channel.
            var client = serverLookup[ircRoom.server.domain];
            if (!client) {
                return; // not connected to this server
            }
            // leave it; if we aren't joined this will no-op.
            promises.push(client.leaveChannel(ircRoom.channel));
        });

        // =========== Bridge Bot Parting ===========
        // For membership list syncing only
        ircRooms.forEach(function(ircRoom) {
            if (!ircRoom.server.shouldJoinChannelsIfNoUsers()) {
                membershiplists.checkBotPartRoom(ircRoom, req);
            }
        });

        Promise.all(promises).done(req.sucFn, req.errFn);
    }, req.errFn);
    return req.defer.promise;
};

/**
 * Called when the AS receives a new Matrix Event.
 * @param {Object} event : A Matrix event
 * @param {Request=} existingRequest : An existing request correlated to
 * this event, or null.
 * @return {Promise} which is resolved/rejected when the request finishes.
 */
module.exports.onMessage = function(event, existingRequest) {
    /*
     * Valid message flows:
     * Matrix --> IRC (Bridged communication)
     * Matrix --> Matrix (Admin room)
     */

    /* type {Request} */
    var req = existingRequest || requests.newRequest(false);

    req.log.info("%s usr=%s rm=%s body=%s",
        event.type, event.user_id, event.room_id,
        (event.content.body ? event.content.body.substring(0, 20) : ""));

    if (processingInvitesForRooms[event.room_id + event.user_id]) {
        req.log.info(
            "Holding request for %s until invite for room %s is done.",
            event.user_id, event.room_id
        );
        holdEvent(event, req);
        return req.defer.promise;
    }

    if (matrixLib.getAppServiceUserId() === event.user_id) {
        // ignore messages from the bot
        req.defer.reject(new Error(requests.ERR_VIRTUAL_USER));
        return req.defer.promise;
    }

    var ircAction = actions.toIrc(actions.matrix.createAction(event));
    store.rooms.getIrcChannelsForRoomId(event.room_id).done(
    function(ircRooms) {
        if (ircRooms.length === 0) {
            // could be an Admin room, so check.
            store.rooms.getAdminRoomById(event.room_id).done(
            function(room) {
                if (!room) {
                    req.log.info("No mapped channels.");
                    req.sucFn();
                    return;
                }
                // process admin request
                onAdminMessage(event, req, room);
            }, req.errFn);
            return;
        }
        var promises = [];

        ircRooms.forEach(function(ircRoom) {
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
            if (!ircLib.getIrcUserFromCache(ircRoom.server, event.user_id)) {
                promises.push(req.mxLib.getDisplayName(
                    event.room_id, event.user_id
                ).then(function(displayName) {
                    return req.ircLib.getBridgedClient(
                        ircRoom.server, event.user_id, displayName
                    );
                }, function(err) {
                    req.log.error("Failed to get display name: %s", err);
                    // this is non-fatal, continue.
                    return req.ircLib.getBridgedClient(
                        ircRoom.server, event.user_id
                    );
                }).then(function(ircUser) {
                    return req.ircLib.sendAction(
                        ircRoom, ircUser, ircAction
                    );
                }));
            }
            else {
                promises.push(req.ircLib.getBridgedClient(
                    ircRoom.server, event.user_id
                ).then(function(ircUser) {
                    return req.ircLib.sendAction(
                        ircRoom, ircUser, ircAction
                    );
                }));
            }
        });

        Promise.all(promises).done(req.sucFn, req.errFn);
    }, req.errFn);

    return req.defer.promise;
};

/**
 * Called when the AS receives an alias query from the HS.
 * @param {string} roomAlias : The room alias queried.
 * @return {Promise} which is resolved/rejected when the request finishes.
 */
module.exports.onAliasQuery = function(roomAlias) {
    /* type {Request} */
    var req = requests.newRequest(false);

    req.log.info("onAliasQuery %s", roomAlias);

    // check if alias maps to a valid IRC server and channel
    var channelInfo = ircLib.aliasToIrcChannel(roomAlias);
    if (!channelInfo.channel) {
        req.errFn("Unknown alias: %s", roomAlias);  // bad alias
        return req.defer.promise;
    }
    if (!channelInfo.server.createsPublicAliases()) {
        req.errFn("This server does not allow alias mappings.");
        return req.defer.promise;
    }
    req.log.info("Mapped to %s on %s",
        channelInfo.channel, channelInfo.server.domain
    );

    // See if we are already tracking this channel (case-insensitive
    // channels but case-sensitive aliases)
    store.rooms.getMatrixRoomsForChannel(
        channelInfo.server, channelInfo.channel
    ).done(function(matrixRooms) {
        if (matrixRooms.length === 0) {
            // lower case the name to join (there's a bug in the IRC lib
            // where the join callback never fires if you try to join
            // #WithCaps in channels :/)
            channelInfo.channel = toIrcLowerCase(channelInfo.channel);
            req.log.info("Going to track channel %s", channelInfo.channel);
            // join the irc server + channel
            ircLib.trackChannel(channelInfo.server, channelInfo.channel).then(
                function(ircRoom) {
                    req.log.info("Bot is now tracking channel.");
                    return req.mxLib.createRoomWithAlias(
                        roomAlias, channelInfo.channel, undefined,
                        channelInfo.server.getJoinRule(),
                        channelInfo.server.shouldFederate(),
                        channelInfo.server.shouldPublishRooms()
                    );
                }
            ).then(function(matrixRoom) {
                req.log.info("Matrix room %s created.", matrixRoom.roomId);
                // TODO set topic, add matrix members f.e. irc user(?) given
                // they are cheap to do.

                // store the mapping and return OK
                var ircRoom = new IrcRoom(
                    channelInfo.server, channelInfo.channel
                );
                store.rooms.set(ircRoom, matrixRoom);
                req.sucFn();
            }).catch(req.errFn);
        }
        else {
            // create an alias pointing to this room (take first)
            // TODO: Take first with public join_rules
            var roomId = matrixRooms[0].roomId;
            req.log.info("Pointing alias %s to %s", roomAlias, roomId);
            req.mxLib.addAlias(roomId, roomAlias).done(
                req.sucFn, req.errFn
            );
        }
    }, req.errFn);

    return req.defer.promise;
};

/**
 * Called when the AS receives a user query from the HS.
 * @param {string} userId : The user ID queried.
 * @return {Promise} which is resolved/rejected when the request finishes.
 */
module.exports.onUserQuery = function(userId) {
    /* type {Request} */
    var req = requests.newRequest(false);

    if (matrixLib.getAppServiceUserId() === userId) {
        req.sucFn();
    }
    req.log.info("onUserQuery: %s", userId);
    var matrixUser = new MatrixUser(userId, null, true);

    ircLib.matrixToIrcUser(matrixUser).then(function(ircUser) {
        return createMatrixUserForIrcUser(ircUser, req);
    }).done(req.sucFn, req.errFn);

    return req.defer.promise;
};
