/*
 * This file ties together the IRC and Matrix interfaces into a bridge between
 * the two.
 */
"use strict";
var q = require("q");

var matrixLib = require("./mxlib/matrix");
var ircLib = require("./irclib/irc");
var store = require("./store");
var protocols = require("./protocols");

var roomModels = require("./models/rooms");
var actions = require("./models/actions");
var users = require("./models/users");
var requests = require("./models/requests");

var logging = require("./logging")
var log = logging.get("bridge");

// FIXME: kill this
var createMatrixUserForIrcUser = function(ircUser, req) {
    var defer = q.defer();

    ircLib.checkNickExists(ircUser.server, ircUser.nick).then(function(info) {
        req.log.info("Creating virtual user for %s on %s", 
            ircUser.nick, ircUser.server.domain);
        return protocols.mapToMatrix("users", ircUser);
    }).then(function(user) {
        req.log.info("Created virtual user %s", user.userId);
        defer.resolve(user);
    }, function(err) {
        req.log.error("Virtual user creation for %s failed: %s", 
            ircUser.nick, err);   
        defer.reject(err);
    }).done();

    return defer.promise;
}

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
}

module.exports.hooks = {
    matrix: {
        onInvite: function(event) {
            var req = requests.newRequest();
            req.log.info("onInvite: %s", JSON.stringify(event));

            processingInvitesForRooms[event.room_id] = req.defer.promise;
            req.defer.promise.fin(function() {
                processingInvitesForRooms[event.room_id] = undefined;
            });

            var botInvitedUser = (
                matrixLib.getAppServiceUserId() === event.user_id
            );
            var userInvitedBot = (
                matrixLib.getAppServiceUserId() === event.state_key
            );

            if (userInvitedBot) {
                // invite is for the AS (e.g. private room), join it IFF we know
                // the room (hard-coded or dynamic or PM)
                store.getAllKnownRoomIds().then(function(roomIds) {
                    if (roomIds.indexOf(event.room_id) !== -1) {
                        // known room
                        return matrixLib.joinRoom(event.room_id, undefined);
                    }
                    return q.reject(
                        "Bot invited to unknown room: "+event.room_id
                    );
                }).then(function() {
                    req.log.info("Bot joined room %s", event.room_id);
                }).done(req.sucFn, req.errFn);
                return req.defer.promise;
            }


            var invitedUser = users.matrix.createUser(
                event.state_key, true
            );
            var realIrcUser;
            var virtualMatrixUser;
            // First, try to map the invitee to an IRC user.
            protocols.mapToIrc("users", invitedUser).then(function(ircUser) {
                if (!ircUser.server.allowsPms()) {
                    req.log.error(
                        "Rejecting invite: This server does not allow PMs."
                    );
                    return q.reject("Server disallows PMs");
                }
                realIrcUser = ircUser;
                // create a virtual Matrix user for the IRC user
                return createMatrixUserForIrcUser(ircUser, req);
            }).then(function(user) {
                virtualMatrixUser = user;
                // make them join the room they have been invited to.
                return matrixLib.joinRoom(event.room_id, virtualMatrixUser);
            }).then(function() {
                req.log.info(
                    "Joined %s to room %s", invitedUser.userId, event.room_id
                );
                return matrixLib.isPmRoom(
                    invitedUser.userId, event.room_id, event.user_id
                );
            }).then(function(isPmRoom) {
                if (isPmRoom) {
                    var mxRoom = roomModels.matrix.createRoom(event.room_id);
                    // nick is the channel
                    var ircRoom = roomModels.irc.createRoom(
                        realIrcUser.server, realIrcUser.nick
                    );
                    var pmRoom = roomModels.createBridgedRoom(ircRoom, mxRoom);
                    return store.storePmRoom(
                        pmRoom, event.user_id, event.state_key
                    );
                }
                else if (!botInvitedUser) {
                    req.log.error("This room isn't a 1:1 chat!");
                    // whine that you don't do group chats and leave.
                    matrixLib.sendNoticeRaw(
                        event.room_id, invitedUser.userId, 
                        "Group chat not supported."
                    ).finally(function() {
                        matrixLib.leaveRoom(invitedUser.userId, event.room_id).done(
                            req.sucFn, req.errFn
                        );
                    });
                }
            }).done(req.sucFn, req.errFn);

            return req.defer.promise;
        },
        onJoin: function(event) {
            // if this is another Matrix user joining a PM room:
            //  - Whine that you don't do group chats and leave (virtual user)
        },
        onMessage: function(event, existingRequest) {
            var req = existingRequest || requests.newRequest();
            req.log.info("[M->I]%s usr=%s rm=%s", event.type, event.user_id, 
                event.room_id);

            if (processingInvitesForRooms[event.room_id]) {
                req.log.info("Holding request until invite for room %s is done.",
                    event.room_id);
                holdEvent(event, req);
                return;
            }

            var ircAction = protocols.mapToIrc(
                "actions", actions.matrix.createAction(event)
            );
            req.log.info("Mapped to action: %s", JSON.stringify(ircAction));
            store.getIrcRoomsForRoomId(event.room_id).done(function(ircRooms) {
                if (ircRooms.length == 0) {
                    req.log.info("No mapped channels.");
                    req.sucFn();
                    return;
                }
                var promises = [];

                ircRooms.forEach(function(ircRoom) {
                    req.log.info("Relaying message in %s on %s", 
                        ircRoom.channel, ircRoom.server.domain);
                    promises.push(ircLib.getVirtualIrcUser(
                        ircRoom.server, event.user_id).then(function(ircUser) {
                            req.log.info("Sending action as: %s", ircUser.nick);
                            return ircLib.sendAction(ircRoom, ircUser, ircAction);
                        })
                    );
                });

                q.all(promises).done(req.sucFn, req.errFn);
            }, req.errFn);

            return req.defer.promise;
        },
        onAliasQuery: function(roomAlias) {
            var req = requests.newRequest();
            req.log.info("onAliasQuery %s", roomAlias);

            // check if alias maps to a valid IRC server and channel
            var channelInfo = protocols.mapToIrc(
                "aliases", roomAlias
            );
            if (!channelInfo.channel) {
                req.errFn("Unknown alias: %s", roomAlias);  // bad alias
                return req.defer.promise;
            }
            if (!channelInfo.server.shouldMapAllRooms()) {
                req.errFn("This server does not allow alias mappings.");
                return req.defer.promise;
            }

            // join the irc server + channel
            ircLib.trackChannel(channelInfo.server, channelInfo.channel).then(
                function(ircRoom) {
                    return matrixLib.createRoomWithAlias(
                        roomAlias, channelInfo.channel
                    );
                }
            ).then(function(matrixRoom) {
                // TODO set topic, add matrix members f.e. irc user(?) given
                // they are cheap to do.

                // store the mapping and return OK
                var ircRoom = roomModels.irc.createRoom(
                    channelInfo.server, channelInfo.channel
                );
                store.storeRoomMapping(ircRoom, matrixRoom);
                req.sucFn();
            }).done(undefined, req.errFn);

            return req.defer.promise;
        },
        onUserQuery: function(userId) {
            var req = requests.newRequest();
            if (matrixLib.getAppServiceUserId() === userId) {
                req.sucFn();
            }
            req.log.info("onUserQuery: %s", userId);
            var matrixUser = users.matrix.createUser(userId, true);

            protocols.mapToIrc("users", matrixUser).then(function(ircUser) {
                return createMatrixUserForIrcUser(ircUser, req);
            }).done(req.sucFn, req.errFn);

            return req.defer.promise;
        }
    },
    irc: {
        onMessage: function(server, from, to, action) {
            var req = requests.newRequest();
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

            var mxAction = protocols.mapToMatrix("actions", action);

            if (!mxAction) {
                req.log.error("Couldn't map IRC action to matrix action");
                return;
            }
            req.log.info("Mapped to action: %s", JSON.stringify(mxAction));

            var virtualMatrixUser = undefined; // sender
            var virtualIrcUser = ircLib.getVirtualUser(toUser); // receiver
            // map the sending IRC user to a Matrix user
            protocols.mapToMatrix("users", fromUser).then(function(user) {
                virtualMatrixUser = user;
                req.log.info("Mapped nick %s to %s", from, JSON.stringify(user));
                if (virtualIrcUser) {
                    // this is actually a PM
                    if (!server.allowsPms()) {
                        req.log.error("Server %s disallows PMs.", server.domain);
                        return;
                    }
                    store.getPmRoom(
                        virtualIrcUser.userId, virtualMatrixUser.userId
                    ).done(function(bridgedRoom) {
                        if (bridgedRoom) {
                            req.log.info("[I->M]Relaying PM in room %s", 
                                bridgedRoom.matrix.roomId);
                            matrixLib.sendAction(
                                bridgedRoom.matrix, virtualMatrixUser, mxAction
                            ).done(req.sucFn, req.errFn);
                            return;
                        }
                        // make a pm room then send the message
                        req.log.info("Creating a PM room with %s", 
                            virtualIrcUser.userId);
                        matrixLib.createRoomWithUser(
                            virtualMatrixUser.userId, virtualIrcUser.userId, 
                            (from + " (PM on " + server.domain + ")")
                        ).done(function(mxRoom) {
                            // the nick is the channel
                            var ircRoom = roomModels.irc.createRoom(server, from);
                            var pmRoom = roomModels.createBridgedRoom(ircRoom, mxRoom);
                            store.storePmRoom(pmRoom, virtualIrcUser.userId, 
                                virtualMatrixUser.userId
                            ).then(function() {
                                return matrixLib.sendAction(
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
                    store.getMatrixRoomsForChannel(server, to).then(function(matrixRooms) {
                        var promises = [];
                        matrixRooms.forEach(function(room) {
                            req.log.info("[I->M]Relaying in room %s", room.roomId);
                            promises.push(matrixLib.sendAction(
                                room, virtualMatrixUser, mxAction
                            ));
                        });
                        if (matrixRooms.length === 0) {
                            req.log.info(
                                "No mapped matrix rooms for IRC channel %s", to
                            );
                        }
                        q.all(promises).done(req.sucFn, req.errFn);
                    });
                }
            }).catch(req.errFn);
        }
    }
};
