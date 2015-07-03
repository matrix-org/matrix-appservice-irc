// Controls the logic for determining which membership lists should be synced and
// handles the sequence of events until the lists are in sync.
"use strict";

var q = require("q");
//var bridge = require("./bridge.js");
//var ircLib = require("./irclib/irc.js");
var matrixLib = require("./mxlib/matrix");
var store = require("./store");
var log = require("./logging").get("membershiplists");

module.exports.sync = function(server) {
    if (!server.isMembershipListsEnabled()) {
        log.info("%s does not have membership list syncing enabled.", server.domain);
        return;
    }

    // collapse the configured rules into 3 lists:
    // - a list of Matrix join events (one for each join membership)
    //     * hit /initialSync on the bot to pull in room state for all rooms.
    //     * filter out non-synced rooms.
    //     * filter out virtual users we made. Get the real ones only.
    //       [diverge point]
    //     * inject these events into the bridge and the bridge will do the work.
    //
    // - a list of IRC join events (one for each connected IRC user.)
    //     * hit /initialSync on the bot to pull in room state for all rooms.
    //     * filter out non-synced rooms.
    //     * filter out virtual users we made. Get the real ones only.
    //       [diverge point]
    //     * filter out rooms which do not have any real users in them.
    //     * map back to IRC channels for the remaining room IDs.
    //     * join MatrixBridge to these channels
    //       (with mirrorJoinPart the joins will sync automatically).
    //
    // - a list of IRC leave events (one for each disconnected IRC user)
    //     [follow on from IRC join events]
    //     * On Matrix rooms, filter out real users. Get virtual ones only.
    //     * Inject a leave event into the bridge for each IRC user who is not
    //       on the IRC member list but is on the virtual IRC user list.
    //
    // - There is no need for a list of Matrix leave events because on shutdown
    //   all connections get killed (leaving everyone).
    log.info("Checking membership lists for syncing on %s", server.domain);
    var rooms = getSyncableRooms(server);
    joinMatrixUsersToChannels(rooms, server).then(function() {
        return joinIrcUsersToRooms(rooms, server);
    }).then(function() {
        return leaveIrcUsersFromRooms(rooms, server);
    }).done(function() {
        log.info("Finished syncing membership lists.");
    }, function(err) {
        log.error("Failed to sync membership lists: %s", err);
    });
};

module.exports.getChannelsToJoin = function(server) {
    log.debug("getChannelsToJoin => %s", server.domain);
    var defer = q.defer();
    // map room IDs to channels on this server.
    getSyncableRooms(server).then(function(rooms) {
        var promises = [];
        var channels = {}; // object for set-like semantics.
        rooms.forEach(function(room) {
            promises.push(store.getIrcChannelsForRoomId(room.roomId).then(
            function(ircRooms) {
                ircRooms = ircRooms.filter(function(ircRoom) {
                    return ircRoom.server.domain === server.domain;
                });
                ircRooms.forEach(function(ircRoom) {
                    channels[ircRoom.channel] = true;
                    log.debug(
                        "%s should be joined because %s real Matrix users are in room %s",
                        ircRoom.channel, room.reals.length, room.roomId
                    );
                    if (room.reals.length < 5) {
                        log.debug("These are: %s", JSON.stringify(room.reals));
                    }
                });
            }));
        });
        q.allSettled(promises).then(function() {
            var chans = Object.keys(channels);
            log.debug(
                "getChannelsToJoin => %s should be synced: %s",
                chans.length, JSON.stringify(chans)
            );
            defer.resolve(chans);
        });
    });

    return defer.promise;
};

// grab all rooms the bot knows about which have at least 1 real user in them.
function getSyncableRooms(server) {
    var mxLib = matrixLib.getMatrixLibFor();
    var defer = q.defer();
    // hit /initialSync on the bot to pull in room state for all rooms.
    mxLib.initialSync().done(function(res) {
        var rooms = res.rooms || [];
        rooms = rooms.map(function(room) {
            return getRoomMemberData(server, room.room_id, room.state);
        });
        // filter out rooms with no real matrix users in them.
        rooms = rooms.filter(function(room) {
            return room.reals.length > 0;
        });
        defer.resolve(rooms);
    });

    return defer.promise;
}

function joinMatrixUsersToChannels(rooms, server) {
    return q();
}

function joinIrcUsersToRooms(rooms, server) {
    return q();
}

function leaveIrcUsersFromRooms(rooms, server) {
    return q();
}

function getRoomMemberData(server, roomId, stateEvents) {
    stateEvents = stateEvents || [];
    var data = {
        roomId: roomId,
        virtuals: [],
        reals: []
    };
    stateEvents.forEach(function(event) {
        if (event.type !== "m.room.member" || event.content.membership !== "join") {
            return;
        }
        var userId = event.state_key;
        if (userId === matrixLib.getAppServiceUserId()) {
            return;
        }
        if (server.claimsUserId(userId)) {
            data.virtuals.push(userId);
        }
        else {
            data.reals.push(userId);
        }
    });
    return data;
}
