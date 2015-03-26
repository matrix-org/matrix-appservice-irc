/*
 * This file ties together the IRC and Matrix interfaces into a bridge between
 * the two.
 */
"use strict";
var q = require("q");
var matrixLib = require("./mxlib/matrix");
var ircLib = require("./irclib/irc");
var roomModels = require("./rooms");
var store = require("./store");
var protocols = require("./protocols");
var actions = require("./actions");
var users = require("./users");
var log = require("./logging").get("bridge");

var createMatrixUserForIrcUser = function(ircUser) {
    var defer = q.defer();

    ircLib.checkNickExists(ircUser.server, ircUser.nick).then(function(info) {
        log.info("Creating virtual user for %s on %s", 
            ircUser.nick, ircUser.server.domain);
        return protocols.mapToMatrix("users", ircUser);
    }).then(function(user) {
        log.info("Created virtual user %s", user.userId);
        defer.resolve(user);
    }, function(err) {
        log.error("Virtual user creation for %s failed: %s", 
            userId, err);   
        defer.reject({});
    }).done();

    return defer.promise;
}

// maintain a list of room IDs which are being processed invite-wise. This is
// required because invites are processed asyncly, so you could get invite->msg
// and the message is processed before the room is created.
var processingInvitesForRooms = {
    // roomId: defer
};

var holdEvent = function(event) {
    processingInvitesForRooms[event.room_id].finally(function() {
        log.info("Finished holding event for room %s", event.room_id);
        module.exports.hooks.matrix.onMessage(event);
    });
}

module.exports.hooks = {
    matrix: {
        onInvite: function(event) {
            var inviteDefer = q.defer();
            processingInvitesForRooms[event.room_id] = inviteDefer.promise;

            // First, try to map the invitee to an IRC user. If this can be done,
            // create a virtual Matrix user for the IRC user and make them join
            // the room they have been invited to.
            log.info("onInvite: %s", JSON.stringify(event));
            var errFn = function(err) {
                log.error(
                    "onInvite: Failed to handle invite from %s to room %s : %s",
                    event.user_id, event.room_id, err);
                processingInvitesForRooms[event.room_id] = undefined;
                inviteDefer.reject(err);
            };
            var sucFn = function(err) {
                log.info("onInvite: Processed invite from %s to room %s",
                    event.user_id, event.room_id);
                processingInvitesForRooms[event.room_id] = undefined;
                inviteDefer.resolve();
            };


            var invitedUser = users.matrix.createUser(
                event.state_key, true
            );
            var realIrcUser;
            var virtualMatrixUser;

            return protocols.mapToIrc("users", invitedUser).then(
            function(ircUser) {
                if (!ircUser.server.allowsPms()) {
                    log.error(
                        "Rejecting invite: This server does not allow PMs."
                    );
                    return q.reject("Server disallows PMs");
                }
                realIrcUser = ircUser;
                return createMatrixUserForIrcUser(ircUser);
            }).then(function(user) {
                virtualMatrixUser = user;
                return matrixLib.joinRoom(event.room_id, virtualMatrixUser);
            }).then(function() {
                log.info(
                    "Joined %s to room %s", invitedUser.userId, event.room_id
                );
                return matrixLib.isPmRoom(
                    invitedUser.userId, event.room_id, event.user_id
                );
            }).then(function(isPmRoom) {
                if (isPmRoom) {
                    // clobber any existing PM room
                    // FIXME: Need a unified room object here
                    var pmRoom = roomModels.createMatrixRoom(event.room_id);
                    pmRoom.server = realIrcUser.server;
                    pmRoom.channel = realIrcUser.nick;
                    return store.storePmRoom(
                        pmRoom, event.user_id, event.state_key
                    );
                }
                else {
                    log.error("This room isn't a 1:1 chat!");
                    // whine that you don't do group chats and leave.
                    matrixLib.sendNoticeRaw(
                        event.room_id, invitedUser.userId, 
                        "Group chat not supported."
                    ).finally(function() {
                        matrixLib.leaveRoom(invitedUser.userId, event.room_id).done(
                            sucFn, errFn
                        );
                    });
                }
            }).done(sucFn, errFn); 
        },
        onJoin: function(event) {
            // if this is another Matrix user joining a PM room:
            //  - Whine that you don't do group chats and leave (virtual user)
        },
        onMessage: function(event) {
            log.info("[M->I]%s usr=%s rm=%s", event.type, event.user_id, 
                event.room_id);

            if (processingInvitesForRooms[event.room_id]) {
                log.info("Holding message until invite for room %s is done.",
                    event.room_id);
                holdEvent(event);
                return;
            }

            var ircAction = protocols.mapToIrc(
                "actions", actions.matrix.createAction(event)
            );
            store.getIrcRoomsForRoomId(event.room_id).done(
            function(ircRooms) {
                if (ircRooms.length == 0) {
                    log.info("No mapped channels.");
                    return;
                }
                ircRooms.forEach(function(ircRoom) {
                    log.info("Relaying message in %s on %s", 
                        ircRoom.channel, ircRoom.server.domain);

                    if (event.content.msgtype === "m.image") {
                        // sent by the bot
                        var msg = "<"+event.user_id+"> posted an image: "+
                              matrixLib.decodeMxc(event.content.url)+
                              " - "+event.content.body;
                        ircLib.sendBotText(
                            ircRoom.server, ircRoom.channel, msg
                        ).done(function() {
                            log.info("Relayed image text.");
                        });
                        return;
                    }

                    ircLib.getVirtualIrcUser(ircRoom.server, event.user_id).then(
                        function(ircUser) {
                            if (!ircUser) {
                                log.error("Unknown IRC user for user ID %s", 
                                    event.user_id);
                                return;
                            }
                            log.info("Obtained virtual IRC user: %s", 
                                ircUser.nick);
                            ircUser.sendAction(ircRoom, ircAction);
                    }).done(function() {
                        log.info("[M->I] Sent message.");
                    }, function(err) {
                        log.error("[M->I]Failed to relay Matrix message: %s", 
                            JSON.stringify(err));
                    });
                });
            }, function(err) {
                log.error("Failed to get rooms for room ID %s", 
                    event.room_id);
            });
        },
        onAliasQuery: function(roomAlias) {
            log.info("onAliasQuery %s", roomAlias);
            var defer = q.defer();
            // check if alias maps to a valid IRC server and channel
            var channelInfo = protocols.mapToIrc(
                "aliases", roomAlias
            );
            if (!channelInfo.channel) {
                log.info("Unknown alias: %s", roomAlias);
                return q.reject();  // bad alias
            }
            if (!channelInfo.server.shouldMapAllRooms()) {
                log.error("This server does not allow alias mappings.");
                return q.reject();
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
                matrixRoom.channel = channelInfo.channel;
                matrixRoom.server = channelInfo.server;
                store.storeRoom(matrixRoom);
                defer.resolve({});
            }).done(undefined, function(err) {
                log.error(
                    "onAliasQuery: Failed to create a room for alias %s : %s",
                    roomAlias, err
                );
                defer.reject(err);
            });

            return defer.promise;
        },
        onUserQuery: function(userId) {
            log.info("onUserQuery: %s", userId);
            var matrixUser = users.matrix.createUser(userId, true);

            return protocols.mapToIrc("users", matrixUser).then(
            function(ircUser) {
                return createMatrixUserForIrcUser(ircUser);
            });
        }
    },
    irc: {
        onMessage: function(server, from, to, action) {
            log.info("[I->M]onMessage: from=%s to=%s action=%s",
                from, to, JSON.stringify(action));

            // Attempt to make IRC users for from/to
            var fromUser = users.irc.createUser(
                server, from, ircLib.isNickVirtualUser(server, from)
            );
            var toUser = users.irc.createUser(
                server, to, ircLib.isNickVirtualUser(server, to)
            );

            if (fromUser.isVirtual) {
                return; // don't send stuff which were sent from bots
            }

            var mxAction = protocols.mapToMatrix("actions", action);

            if (!mxAction) {
                log.error("Couldn't map IRC action to matrix action");
                return;
            }

            var errFn = function(err) {
                log.error("[I->M]Failed to relay IRC message: %s", 
                    JSON.stringify(err));
            };
            var virtualMatrixUser = undefined; // sender
            var virtualIrcUser = ircLib.getVirtualUser(toUser); // receiver
            // map the sending IRC user to a Matrix user
            protocols.mapToMatrix("users", fromUser).then(function(user) {
                virtualMatrixUser = user;
                log.info("Mapped real IRC user to %s", JSON.stringify(user));
                if (virtualIrcUser) {
                    // this is actually a PM
                    if (!server.allowsPms()) {
                        log.error("Server %s disallows PMs.", server.domain);
                        return;
                    }
                    var pmRoom = undefined;
                    store.getPmRoom(
                        virtualIrcUser.userId, virtualMatrixUser.userId
                    ).then(function(room) {
                        if (room) {
                            log.info("[I->M]Relaying PM in room %s", room.roomId);
                            matrixLib.sendAction(
                                room, virtualMatrixUser, mxAction
                            ).done(undefined, errFn);
                            return;
                        }
                        // make a pm room then send the message
                        log.info("Creating a PM room with %s", 
                            virtualIrcUser.userId);
                        return matrixLib.createRoomWithUser(
                            virtualMatrixUser.userId, virtualIrcUser.userId, 
                            (from + " (PM on " + server.domain + ")")
                        );
                    }).then(function(room) {
                        room.server = server; // FIXME
                        room.channel = from;
                        pmRoom = room;
                        return store.storePmRoom(
                            pmRoom, virtualIrcUser.userId, 
                            virtualMatrixUser.userId
                        );
                    }).then(function() {
                        return matrixLib.sendAction(
                            pmRoom,
                            virtualMatrixUser,
                            mxAction
                        );
                    }).done(undefined, errFn);
                }
                else {
                    // this is directed at a channel
                    store.getRoomsForChannel(server, to).then(function(matrixRooms) {
                        matrixRooms.forEach(function(room) {
                            log.info("[I->M]Relaying in room %s", room.roomId);
                            matrixLib.sendAction(
                                room, virtualMatrixUser, mxAction
                            ).done(undefined, errFn);
                        });
                    })
                }
            }).done(undefined, errFn);
        }
    }
};
