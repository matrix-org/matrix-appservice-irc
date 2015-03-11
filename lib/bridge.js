"use strict";
var q = require("q");
var matrixLib = require("./mxlib/matrix");
var ircLib = require("./irclib/server-pool");

var getIrcUser = function(userId) {

};

var msgTypes = {
    message: "m.text",
    privmsg: "m.emote",
    notice: "m.notice",
    "m.text": "message",
    "m.emote": "privmsg",
    "m.notice": "notice"
};

module.exports.hooks = {
    matrix: {
        onInvite: function(event) {
            // if this is for a virtual user:
            //  - join the room as the virtual user
            //  - if member list is just the virtual user and the inviter:
            //      - Clobber the PM room with the invited room ID
            //      - Store the PM room (IRC user / Matrix user tuple) forever
            //  - else:
            //      - whine that you don't do group chats and leave.
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

            var ircUser = ircLib.getVirtualIrcUser(
                ircRoom.server, event.user_id
            );

            if (!ircUser) {
                console.error("Unknown IRC user for user ID %s", event.user_id);
                return;
            }

            var errFn = function(err) {
                console.error("[M->I]Failed to relay Matrix message: %s", 
                    JSON.stringify(err));
            };
            var msgtype = msgTypes[event.content.msgtype];
            var msg = event.content.body;

            ircUser.sendMessage(ircRoom, msgtype, msg).done(function(){
                console.log("[M->I] Sent message.");
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
            // if user ID maps to a valid IRC server and nick:
            //  - register the virtual user ID
            //  - Set display name / IRC-icon
            //  - respond OK
            return q.reject({});
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

            if (ircLib.isVirtualUser(server, from)) {
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
