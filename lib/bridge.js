/*
 * This file ties together the IRC and Matrix interfaces into a bridge between
 * the two.
 */
"use strict";
var q = require("q");

var matrixLib = require("./mxlib/matrix");
var ircLib = require("./irclib/irc");
var store = require("./store");

var roomModels = require("./models/rooms");
var actions = require("./models/actions");
var users = require("./models/users");
var requests = require("./models/requests");

var logging = require("./logging");
var log = logging.get("bridge");

// FIXME: kill this
var createMatrixUserForIrcUser = function(ircUser, req) {
    var defer = q.defer();

    ircLib.checkNickExists(ircUser.server, ircUser.nick).then(function(info) {
        req.log.info("Creating virtual user for %s on %s", 
            ircUser.nick, ircUser.server.domain);
        return matrixLib.ircToMatrixUser(ircUser);
    }).then(function(user) {
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
    // roomId: defer
};

var holdEvent = function(event, request) {
    processingInvitesForRooms[event.room_id].finally(function() {
        request.log.info("Finished holding event for room %s", event.room_id);
        module.exports.hooks.matrix.onMessage(event, request);
    });
};

// ===== Matrix Invite Handling =====

var handleAdminRoomInvite = function(event, req, inviter, botUser) {
    req.log.info("Handling invite from user directed to bot.");
    // Real MX user inviting BOT to a private chat
    var mxRoom = roomModels.matrix.createRoom(event.room_id);
    req.mxLib.joinRoom(event.room_id, botUser).then(function() {
        // clobber any previous admin room ID
        return store.storeAdminRoom(mxRoom, inviter.userId);
    }).done(req.sucFn, req.errFn);
};

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
        return q.reject("Server disallows PMs");
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
        var mxRoom = roomModels.matrix.createRoom(event.room_id);
        if (isPmRoom) {
            // nick is the channel
            var ircRoom = roomModels.irc.createRoom(
                invitedIrcUser.server, invitedIrcUser.nick
            );
            var pmRoom = roomModels.createBridgedRoom(ircRoom, mxRoom);
            return store.storePmRoom(pmRoom, event.user_id, event.state_key);
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
    var botUser = users.matrix.createUser(
        matrixLib.getAppServiceUserId(), false
    );
    var segments = event.content.body.split(" ");
    if (event.content.body.indexOf("!nick") === 0) {
        // Format is: "!nick irc.example.com NewNick"
        var clientList = ircLib.getVirtualIrcUsersForUserId(event.user_id);
        var i=0;
        // strip servers which don't allow nick changes
        for (i=0; i<clientList.length; i++) {
            if (!clientList[i].server.allowNickChanges) {
                clientList.splice(i, 1);
                i--;
            }
        }
        var ircServer = null;
        for (i=0; i<clientList.length; i++) {
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
                    "You are not currently connected to any "+
                    "IRC networks which have nick changes enabled."
                );
            }
            else {
                connectedNetworksStr = "Currently connected to IRC networks:\n";
                for (i=0; i<clientList.length; i++) {
                    connectedNetworksStr += clientList[i].server.domain+
                        " as " + clientList[i].nick+"\n";
                }
            }
            var notice = actions.matrix.createNotice(
                "Format: '!nick irc.example.com DesiredNick'\n"+
                connectedNetworksStr
            );
            req.mxLib.sendAction(adminRoom, botUser, notice).done(
                req.sucFn, req.errFn
            );
            return;
        }
        req.log.info("%s wants to change their nick on %s to %s", 
            event.user_id, ircServer.domain, nick);

        // change the nick
        ircLib.getVirtualIrcUser(ircServer, event.user_id).then(
        function(ircUser) {
            return ircUser.changeNick(nick);
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
        else if (!server.exposesChannelsPublicly() && 
                server.whitelist.indexOf(event.user_id) === -1) {
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
        store.getMatrixRoomsForChannel(server, ircChannel).done(
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
                q.all(promises).done(req.sucFn, req.errFn);
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
                    return store.storeRoomMapping(ircRoom, mxRoom);
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

module.exports.hooks = {
    matrix: {
        onInvite: function(event, inviter, invitee) {
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
            processingInvitesForRooms[event.room_id] = req.defer.promise;
            req.defer.promise.fin(function() {
                processingInvitesForRooms[event.room_id] = undefined;
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
        },
        onJoin: function(event) {
            // TODO if this is another Matrix user joining a PM room:
            //  - Whine that you don't do group chats and leave (virtual user)
        },
        onMessage: function(event, existingRequest) {
            /*
             * Valid message flows:
             * Matrix --> IRC (Bridged communication)
             * Matrix --> Matrix (Admin room)
             */
            var req = existingRequest || requests.newRequest(false);
            req.log.info("[M->I]%s usr=%s rm=%s body=%s", 
                event.type, event.user_id, event.room_id,
                (event.content.body ? event.content.body.substring(0, 20) : ""));

            if (processingInvitesForRooms[event.room_id]) {
                req.log.info(
                    "Holding request until invite for room %s is done.",
                    event.room_id
                );
                holdEvent(event, req);
                return req.defer.promise;
            }

            if (matrixLib.getAppServiceUserId() === event.user_id) {
                // ignore messages from the bot
                req.defer.reject(requests.ERR_VIRTUAL_USER);
                return req.defer.promise;
            }

            var ircAction = actions.toIrc(actions.matrix.createAction(event));
            req.log.info("Mapped to action: %s", JSON.stringify(ircAction));
            store.getIrcChannelsForRoomId(event.room_id).done(
            function(ircRooms) {
                if (ircRooms.length === 0) {
                    // could be an Admin room, so check.
                    store.getAdminRoomById(event.room_id).done(function(room) {
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
                    req.log.info("Relaying message in %s on %s", 
                        ircRoom.channel, ircRoom.server.domain);
                    promises.push(ircLib.getVirtualIrcUser(
                        ircRoom.server, event.user_id).then(function(ircUser) {
                            req.log.info(
                                "Sending action as: %s", ircUser.nick
                            );
                            return ircLib.sendAction(
                                ircRoom, ircUser, ircAction
                            );
                        })
                    );
                });

                q.all(promises).done(req.sucFn, req.errFn);
            }, req.errFn);

            return req.defer.promise;
        },
        onAliasQuery: function(roomAlias) {
            var req = requests.newRequest(false);
            req.log.info("onAliasQuery %s", roomAlias);

            // check if alias maps to a valid IRC server and channel
            var channelInfo = ircLib.aliasToIrcChannel(roomAlias);
            if (!channelInfo.channel) {
                req.errFn("Unknown alias: %s", roomAlias);  // bad alias
                return req.defer.promise;
            }
            if (!channelInfo.server.exposesChannelsPublicly()) {
                req.errFn("This server does not allow alias mappings.");
                return req.defer.promise;
            }
            req.log.info("Mapped to %s on %s", 
                channelInfo.channel, channelInfo.server.domain
            );

            // join the irc server + channel
            ircLib.trackChannel(channelInfo.server, channelInfo.channel).then(
                function(ircRoom) {
                    req.log.info("Bot is now tracking channel.");
                    return req.mxLib.createRoomWithAlias(
                        roomAlias, channelInfo.channel
                    );
                }
            ).then(function(matrixRoom) {
                req.log.info("Matrix room %s created.", matrixRoom.roomId);
                // TODO set topic, add matrix members f.e. irc user(?) given
                // they are cheap to do.

                // store the mapping and return OK
                var ircRoom = roomModels.irc.createRoom(
                    channelInfo.server, channelInfo.channel
                );
                store.storeRoomMapping(ircRoom, matrixRoom);
                req.sucFn();
            }).catch(req.errFn);

            return req.defer.promise;
        },
        onUserQuery: function(userId) {
            var req = requests.newRequest(false);
            if (matrixLib.getAppServiceUserId() === userId) {
                req.sucFn();
            }
            req.log.info("onUserQuery: %s", userId);
            var matrixUser = users.matrix.createUser(userId, true);

            ircLib.matrixToIrcUser(matrixUser).then(function(ircUser) {
                return createMatrixUserForIrcUser(ircUser, req);
            }).done(req.sucFn, req.errFn);

            return req.defer.promise;
        }
    },
    irc: {
        onMessage: function(server, from, to, action) {
            var req = requests.newRequest(true);
            req.log.info("[I->M]onMessage: %s from=%s to=%s action=%s",
                server.domain, from, to, JSON.stringify(action));

            // Attempt to make IRC users for from/to
            var fromUser = users.irc.createUser(
                server, from, ircLib.isNickVirtualUser(server, from)
            );
            var toUser = users.irc.createUser(
                server, to, ircLib.isNickVirtualUser(server, to)
            );

            if (fromUser.isVirtual) {
                req.defer.reject(requests.ERR_VIRTUAL_USER);
                return; // don't send stuff which were sent from bots
            }

            var mxAction = actions.toMatrix(action);

            if (!mxAction) {
                req.log.error("Couldn't map IRC action to matrix action");
                return;
            }
            req.log.info("Mapped to action: %s", JSON.stringify(mxAction));

            var virtualMatrixUser; // sender
            var virtualIrcUser = ircLib.getVirtualUser(toUser); // receiver
            // map the sending IRC user to a Matrix user
            matrixLib.ircToMatrixUser(fromUser).then(function(user) {
                virtualMatrixUser = user;
                req.log.info(
                    "Mapped nick %s to %s", from, JSON.stringify(user)
                );
                if (virtualIrcUser) {
                    // this is actually a PM
                    if (!server.allowsPms()) {
                        req.log.error(
                            "Server %s disallows PMs.", server.domain
                        );
                        return;
                    }
                    store.getPmRoom(
                        virtualIrcUser.userId, virtualMatrixUser.userId
                    ).done(function(bridgedRoom) {
                        if (bridgedRoom) {
                            req.log.info("[I->M]Relaying PM in room %s", 
                                bridgedRoom.matrix.roomId);
                            req.mxLib.sendAction(
                                bridgedRoom.matrix, virtualMatrixUser, mxAction
                            ).done(req.sucFn, req.errFn);
                            return;
                        }
                        // make a pm room then send the message
                        req.log.info("Creating a PM room with %s", 
                            virtualIrcUser.userId);
                        req.mxLib.createRoomWithUser(
                            virtualMatrixUser.userId, virtualIrcUser.userId, 
                            (from + " (PM on " + server.domain + ")")
                        ).done(function(mxRoom) {
                            // the nick is the channel
                            var ircRoom = roomModels.irc.createRoom(
                                server, from
                            );
                            var pmRoom = roomModels.createBridgedRoom(
                                ircRoom, mxRoom
                            );
                            store.storePmRoom(pmRoom, virtualIrcUser.userId, 
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
                }
                else {
                    // this is directed at a channel
                    store.getMatrixRoomsForChannel(server, to).then(
                    function(matrixRooms) {
                        var promises = [];
                        matrixRooms.forEach(function(room) {
                            req.log.info(
                                "[I->M]Relaying in room %s", room.roomId
                            );
                            promises.push(req.mxLib.sendAction(
                                room, virtualMatrixUser, mxAction
                            ));
                        });
                        if (matrixRooms.length === 0) {
                            req.log.info(
                                "No mapped matrix rooms for IRC channel %s", to
                            );
                        }
                        q.all(promises).done(req.sucFn, req.errFn);
                    }).catch(req.errFn);
                }
            }).catch(req.errFn);
        },
        onJoin: function(server, nick, chan, kind) {
            if (!server.shouldMirrorJoinParts()) {
                return;
            }
            var req = requests.newRequest(true);
            req.log.info("[I->M]onJoin(%s) %s to %s", kind, nick, chan);
            var joiningUser = users.irc.createUser(
                server, nick, ircLib.isNickVirtualUser(server, nick)
            );
            // if the person joining is a virtual IRC user, do nothing.
            if (joiningUser.isVirtual) {
                req.defer.reject(requests.ERR_VIRTUAL_USER);
                return; // don't send stuff which were sent from bots
            }
            // get virtual matrix user
            var matrixUser;
            matrixLib.ircToMatrixUser(joiningUser).then(function(user) {
                req.log.info(
                    "Mapped nick %s to %s", nick, JSON.stringify(user)
                );
                matrixUser = user;
                return store.getMatrixRoomsForChannel(server, chan);
            }).then(function(matrixRooms) {
                var promises = [];
                matrixRooms.forEach(function(room) {
                    req.log.info(
                        "[I->M]Joining room %s", room.roomId
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
            // TODO
            // create virtual matrix user
            // join mapped rooms
        },
        onPart: function(server, nick, chan, kind) {
            if (!server.shouldMirrorJoinParts()) {
                return;
            }
            var req = requests.newRequest(true);
            req.log.info("[I->M]onPart(%s) %s to %s", kind, nick, chan);
            var leavingUser = users.irc.createUser(
                server, nick, ircLib.isNickVirtualUser(server, nick)
            );
            // get virtual matrix user
            var matrixUser;
            matrixLib.ircToMatrixUser(leavingUser).then(function(user) {
                req.log.info(
                    "Mapped nick %s to %s", nick, JSON.stringify(user)
                );
                matrixUser = user;
                return store.getMatrixRoomsForChannel(server, chan);
            }).then(function(matrixRooms) {
                var promises = [];
                matrixRooms.forEach(function(room) {
                    req.log.info(
                        "[I->M]Leaving room %s", room.roomId
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
        }
    }
};
