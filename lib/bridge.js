/*
 * This file ties together the IRC and Matrix interfaces into a bridge between
 * the two.
 */
"use strict";
var q = require("q");
var matrixLib = require("./mxlib/matrix");
var ircLib = require("./irclib/irc");
var identifiers = require("./identifiers");
var models = require("./models");
var store = new models.RoomStore();
module.exports.store = store;

var msgTypes = {
    message: "m.text",
    privmsg: "m.emote",
    notice: "m.notice",
    "m.text": "message",
    "m.emote": "privmsg",
    "m.notice": "notice"
};

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
        console.log("Creating virtual user for %s on %s", 
            nick, server.domain);
        var localpart = identifiers.createUserLocalpartForServerNick(
            server, nick
        );
        return matrixLib.getMatrixUser(localpart);
    }).then(function(user) {
        console.log("Created virtual user %s", user.userId);
        defer.resolve(user);
    }, function(err) {
        console.error("Virtual user creation for %s failed: %s", 
            userId, err);   
        defer.reject({});
    }).done();

    return defer.promise;
}

module.exports.hooks = {
    matrix: {
        onInvite: function(event) {
            console.log("onInvite: %s", JSON.stringify(event));
            var errFn = function(err) {
                console.error(
                    "onInvite: Failed to handle invite from %s to room %s : %s",
                    userId, event.room_id, err);
            };
            var userId = event.state_key;
            createMatrixUserWithIrcUserId(userId).then(function(user) {
                return matrixLib.joinRoom(event.room_id, user);
            }).then(function() {
                console.log("Joined %s to room %s", userId, event.room_id);
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
                    var virtualIrcUserTarget = identifiers.userIdToServerNick(
                        userId, ircLib.getServers()
                    );
                    var room = models.createMatrixRoom(event.room_id);
                    room.server = virtualIrcUserTarget.server;
                    room.channel = virtualIrcUserTarget.nick;
                    store.storeRoom(room);

                    var virtualIrcUser = identifiers.userIdToServerNick(
                        userId, ircLib.getServers()
                    );
                    room = models.createMatrixRoom(event.room_id);
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
                    // whine that you don't do group chats and leave.
                    matrixLib.sendNoticeRaw(
                        event.room_id, userId, "Group chat not supported."
                    ).finally(function() {
                        matrixLib.leaveRoom(userId, event.room_id).done(
                            undefined, errFn
                        );
                    });
                }
            }).done(); 
        },
        onJoin: function(event) {
            // if this is another Matrix user joining a PM room:
            //  - Whine that you don't do group chats and leave (virtual user)
        },
        onMessage: function(event) {
            // if message is in a tracked room, echo to IRC room.

            // TODO: if message is in a PM room, PM IRC user (from Matrix user)
            // else complain and send an error back (could be a stale PM room)
            console.log("[M->I]onMessage usr=%s rm=%s", event.user_id, 
                event.room_id);

            var ircRooms = store.getRoomsForRoomId(event.room_id);
            
            if (ircRooms.length == 0) {
                console.log("No mapped channels.");
                return;
            }

            ircRooms.forEach(function(ircRoom) {
                console.log("Relaying message in %s on %s", 
                    ircRoom.channel, ircRoom.server.domain);
                ircLib.getVirtualIrcUser(ircRoom.server, event.user_id).then(
                    function(ircUser) {
                        if (!ircUser) {
                            console.error("Unknown IRC user for user ID %s", 
                                event.user_id);
                            return;
                        }
                        console.log("Obtained virtual IRC user: %s", 
                            ircUser.nick);
                        var msgtype = msgTypes[event.content.msgtype];
                        var msg = event.content.body;
                        return ircUser.sendMessage(ircRoom, msgtype, msg);
                }).done(function() {
                    console.log("[M->I] Sent message.");
                }, function(err) {
                    console.error("[M->I]Failed to relay Matrix message: %s", 
                        JSON.stringify(err));
                });
            });
        },
        onAliasQuery: function(roomAlias) {
            console.log("onAliasQuery %s", roomAlias);
            var defer = q.defer();
            // if alias maps to a valid IRC server and channel:
            var channelInfo = identifiers.aliasToServerChannel(
                roomAlias, ircLib.getServers()
            );
            if (!channelInfo.channel) {
                console.log("Unknown alias: %s", roomAlias);
                return q.reject({});;  // bad alias
            }

            //  - create a matrix room
            //  - join the irc server (if haven't already)
            //  - join the channel
            //  - STORE THE NEW DYNAMIC MAPPING FOREVERMORE (so if you get
            //    restarted, you know to track this room)
            //  - respond OK
            return q.reject({});
        },
        onUserQuery: function(userId) {
            console.log("onUserQuery: %s", userId);
            return createMatrixUserWithIrcUserId(userId);
        }
    },
    irc: {
        onMessage: function(server, from, to, kind, msg) {
            console.log("[I->M]onMessage: from=%s to=%s kind=%s msg=%s",
                from, to, kind, msg);

            // TODO if message is a PM to a Matrix user, send message in PM 
            // room, creating one if need be.

            var matrixRooms = store.getRoomsForChannel(server, to);

            if (ircLib.isNickVirtualUser(server, from)) {
                console.log("Virtual user: bailing.");
                return;
            }
            if (matrixRooms.length == 0) {
                console.log("No mapped rooms.");
                return; // nothing to do.
            }

            var errFn = function(err) {
                console.error("[I->M]Failed to relay IRC message: %s", 
                    JSON.stringify(err));
            };
            
            matrixLib.getMatrixUser(server.userPrefix+from).done(function(user) {
                matrixRooms.forEach(function(room) {
                    matrixLib.sendMessage(
                        room, user, msgTypes[kind], msg
                    ).done(undefined, errFn);
                });
            }, errFn);
            
        }
    }
};
