/*
 * This file ties together the IRC and Matrix interfaces into a bridge between
 * the two.
 */
"use strict";
var q = require("q");
var matrixLib = require("./mxlib/matrix");
var ircLib = require("./irclib/irc");
var identifiers = require("./identifiers");
var roomModels = require("./rooms");
var store = require("./store");
var protocols = require("./protocols");
var actions = require("./actions");
var users = require("./users");
var log = require("./logging").get("bridge");

var createMatrixUserWithIrcUserId = function(userId) {
    var defer = q.defer();

    var srvNick = identifiers.userIdToServerNick(userId, ircLib.getServers());
    if (!srvNick.server) {
        return q.reject("Bad user ID");
    }

    ircLib.checkNickExists(srvNick.server, srvNick.nick).then(function(info) {
        // make the user
        var server = info.server;
        var nick = info.nick;
        log.info("Creating virtual user for %s on %s", 
            nick, server.domain);
        var localpart = identifiers.createUserLocalpartForServerNick(
            server, nick
        );
        return matrixLib.getMatrixUser(localpart);
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

module.exports.hooks = {
    matrix: {
        onInvite: function(event) {
            log.info("onInvite: %s", JSON.stringify(event));
            var errFn = function(err) {
                log.error(
                    "onInvite: Failed to handle invite from %s to room %s : %s",
                    userId, event.room_id, err);
            };
            var userId = event.state_key;
            var virtualIrcUserTarget = identifiers.userIdToServerNick(
                userId, ircLib.getServers()
            );
            if (!virtualIrcUserTarget.nick) {
                log.error("Invite isn't for an IRC user.");
                return;
            }
            if (!virtualIrcUserTarget.server.allowsPms()) {
                log.error(
                    "Rejecting invite: This server does not allow PMs."
                );
                return;
            }

            createMatrixUserWithIrcUserId(userId).then(function(user) {
                return matrixLib.joinRoom(event.room_id, user);
            }).then(function() {
                log.info("Joined %s to room %s", userId, event.room_id);
                return matrixLib.isPmRoom(userId, event.room_id, event.user_id);
            }).then(function(isPmRoom) {
                if (isPmRoom) {
                    // make the room. We need two rooms here, mapped to the same
                    // room ID. Best illustrated with an example.
                    // Alice(real IRC) and Bob(real Matrix):
                    // - Bob (event.user_id) initiated this invite to a virtual
                    //   user ID (event.state_key) which maps to a real IRC user
                    //   (Alice).
                    // - When Bob sends a message in the room (event.room_id),
                    //   we need to map to Alice's PM channel (the nick for the
                    //   Alice's user ID (event.state_key)).
                    // - When Alice replies, it goes to a virtual IRC user which
                    //   represents Bob (the nick for Bob's user ID 
                    //   (event.user_id), which needs to be mapped back to Bob's
                    //   real user ID.
                    var room = roomModels.createMatrixRoom(event.room_id);
                    room.server = virtualIrcUserTarget.server;
                    room.channel = virtualIrcUserTarget.nick;
                    store.storeRoom(room);

                    var virtualIrcUser = identifiers.userIdToServerNick(
                        userId, ircLib.getServers()
                    );
                    room = roomModels.createMatrixRoom(event.room_id);
                    // the real matrix user will have a virtual IRC user on the
                    // same server as the target.
                    room.server = virtualIrcUserTarget.server;
                    // FIXME: We cannot guarantee this nick will be free!
                    room.channel = identifiers.createIrcNickForUserId(
                        event.user_id
                    );
                    store.storeRoom(room);
                }
                else {
                    log.error("This room isn't a 1:1 chat!");
                    // whine that you don't do group chats and leave.
                    matrixLib.sendNoticeRaw(
                        event.room_id, userId, "Group chat not supported."
                    ).finally(function() {
                        matrixLib.leaveRoom(userId, event.room_id).done(
                            undefined, errFn
                        );
                    });
                }
            }).done(function() {
                log.info("onInvite: Processed invite.");
            }, function(err) {
                log.error("onInvite: Failed to handle invite: %s", err);
            }); 
        },
        onJoin: function(event) {
            // if this is another Matrix user joining a PM room:
            //  - Whine that you don't do group chats and leave (virtual user)
        },
        onMessage: function(event) {
            log.info("[M->I]%s usr=%s rm=%s", event.type, event.user_id, 
                event.room_id);

            var ircAction = protocols.map("actions",
                protocols.PROTOCOLS.MATRIX,
                protocols.PROTOCOLS.IRC,
                actions.matrix.createAction(event)
            );

            store.getRoomsForRoomId(event.room_id).done(function(ircRooms) {
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
            var channelInfo = identifiers.aliasToServerChannel(
                roomAlias, ircLib.getServers()
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
            return createMatrixUserWithIrcUserId(userId);
        }
    },
    irc: {
        onMessage: function(server, from, to, action) {
            log.info("[I->M]onMessage: from=%s to=%s action=%s",
                from, to, JSON.stringify(action));

            var fromUser = users.irc.createUser(
                server, from, ircLib.isNickVirtualUser(server, from)
            );
            var toUser = users.irc.createUser(
                server, to, ircLib.isNickVirtualUser(server, to)
            );

            if (fromUser.isVirtual) {
                return;
            }

            var mxAction = protocols.map("actions",
                protocols.PROTOCOLS.IRC,
                protocols.PROTOCOLS.MATRIX,
                action
            );

            if (!mxAction) {
                log.error("Couldn't map IRC action to matrix action");
                return;
            }

            var errFn = function(err) {
                log.error("[I->M]Failed to relay IRC message: %s", 
                    JSON.stringify(err));
            };

            if (toUser && server.allowsPms()) {
                // send the PM
                var virtualIrcUser = ircLib.getVirtualUser(toUser);
                if (!virtualIrcUser) {
                    log.error("Received a PM but we don't have a"+
                        " virtual user for nick %s", to);
                    return;
                }
                // make a PM room with this person. First make a user
                // for this IRC person
                var fromUser = undefined;
                matrixLib.getMatrixUser(server.userPrefix+from).then(
                    function(user) {
                        // create the PM room as this user and invite the
                        // real matrix user
                        fromUser = user;
                        return matrixLib.createRoomWithUser(
                            user.userId, virtualIrcUser.userId, 
                            (from + " (PM on " + server.domain + ")")
                        )
                    }
                ).then(function(room) {
                    // persist mapping. We need two rooms here, as with the
                    // other PM room creation logic, due to having 2 
                    // different PM "channels" depending on who sent the
                    // message.
                    var roomForInitiator = roomModels.createMatrixRoom(
                        room.roomId
                    );
                    roomForInitiator.server = server;
                    roomForInitiator.channel = from;
                    store.storeRoom(roomForInitiator);
                    var roomForTarget = roomModels.createMatrixRoom(
                        room.roomId
                    );
                    roomForTarget.server = server;
                    roomForTarget.channel = to;
                    store.storeRoom(roomForTarget);
                    return matrixLib.sendAction(
                        roomForInitiator,
                        fromUser,
                        mxAction
                    );
                }).done(undefined, errFn);
            }
            else if (!toUser) {
                // send message to the channel
                var virtualMatrixUser;
                matrixLib.getMatrixUser(server.userPrefix+from).then(function(user) {
                    virtualMatrixUser = user;
                    return store.getRoomsForChannel(server, to);
                }).then(function(matrixRooms) {
                    matrixRooms.forEach(function(room) {
                        log.info("[I->M]Relaying in room %s", room.roomId);
                        if (mxAction.action === "topic") {
                            matrixLib.setTopic(
                                room, virtualMatrixUser, mxAction.topic
                            ).done(undefined, errFn);
                        }
                        else {
                            matrixLib.sendAction(
                                room, virtualMatrixUser, mxAction
                            ).done(undefined, errFn);
                        }
                    });
                }).done(undefined, errFn);
            }
        }
    }
};
