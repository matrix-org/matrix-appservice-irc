"use strict";
var q = require("q");
var matrixLib = require("./mxlib/matrix");
var ircLib = require("./irclib/irc");

var msgTypes = {
    message: "m.text",
    privmsg: "m.emote",
    notice: "m.notice",
    "m.text": "message",
    "m.emote": "privmsg",
    "m.notice": "notice"
};

var createIrcUserWithUserId = function(userId) {
    var defer = q.defer();

    ircLib.checkNickForUserIdExists(userId).then(function(info) {
        // make the user
        var server = info.server;
        var nick = info.nick;
        console.log("Creating virtual user for %s on %s", 
            nick, server.domain);
        return matrixLib.getMatrixUser(server.userPrefix+nick);
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
            var userId = event.state_key;
            createIrcUserWithUserId(userId).then(function(user) {
                // join the room
                return matrixLib.joinRoom(event.room_id, user);
            }).then(function() {
                console.log("Joined %s to room %s", userId, event.room_id);
                // TODO:
                // if member list is just the virtual user and the inviter:
                // - Clobber the PM room with the invited room ID
                // - Store the PM room (IRC user / Matrix user tuple) forever
                // else whine that you don't do group chats and leave.
            }, function(err) {
                console.error("Failed to join %s to room %s : %s",
                    userId, event.room_id, err);
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
            var ircRoom = ircLib.getIrcRoomForRoomId(event.room_id);

            if (!ircRoom) {
                console.error("Unknown IRC room for room ID %s", event.room_id);
                return;
            }

            var errFn = function(err) {
                console.error("[M->I]Failed to relay Matrix message: %s", 
                    JSON.stringify(err));
            };

            ircLib.getVirtualIrcUser(ircRoom.server, event.user_id).done(
            function(ircUser) {
                if (!ircUser) {
                    console.error("Unknown IRC user for user ID %s", 
                        event.user_id);
                    return;
                }
                var msgtype = msgTypes[event.content.msgtype];
                var msg = event.content.body;

                ircUser.sendMessage(ircRoom, msgtype, msg).done(function(){
                    console.log("[M->I] Sent message.");
                }, errFn);
            }, errFn);
        },
        onAliasQuery: function(roomAlias) {
            // if alias maps to a valid IRC server and channel:
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
            return createIrcUserWithUserId(userId);
        }
    },
    irc: {
        onMessage: function(server, from, to, kind, msg) {
            console.log("[I->M]onMessage: from=%s to=%s kind=%s msg=%s",
                from, to, kind, msg);

            // TODO if message is a PM to a Matrix user, send message in PM 
            // room, creating one if need be.

            // Check tracked channels
            var roomId = server.channelToRoomIds[to];
            if (!roomId) {
                console.error("[I->M]Cannot find room ID for channel %s on %s",
                              to, server.domain);
                return;
            }

            if (ircLib.isNickVirtualUser(server, from)) {
                console.log("Virtual user: bailing.");
                return;
            }

            var errFn = function(err) {
                console.error("[I->M]Failed to relay IRC message: %s", 
                    JSON.stringify(err));
            };
            
            matrixLib.getMatrixUser(server.userPrefix+from).done(function(user) {
                var matrixRoom = matrixLib.getMatrixRoom(roomId);
                matrixLib.sendMessage(
                    matrixRoom, user, msgTypes[kind], msg
                ).done(undefined, errFn);
            }, errFn);
            
        }
    }
};
