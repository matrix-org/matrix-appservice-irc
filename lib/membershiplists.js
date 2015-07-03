// Controls the logic for determining which membership lists should be synced and
// handles the sequence of events until the lists are in sync.
"use strict";

var q = require("q");
//var bridge = require("./bridge.js");
var ircLib = require("./irclib/irc.js");
var matrixLib = require("./mxlib/matrix");
var log = require("./logging").get("membershiplists");

module.exports.sync = function() {
    // are there any servers which need lists synced?
    var servers = ircLib.getServers().filter(function(server) {
        return server.isMembershipListsEnabled();
    });
    if (servers.length === 0) {
        log.info("There are no servers with membership list syncing enabled.");
        return;
    }

    // for each server, collapse the configured rules into 3 lists:
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
    log.info("Checking membership lists for syncing");
    var rooms = getSyncableRooms(servers);
    joinBotToChannels(rooms, servers).then(function() {
        return joinMatrixUsersToChannels(rooms, servers);
    }).then(function() {
        return joinIrcUsersToRooms(rooms, servers);
    }).then(function() {
        return leaveIrcUsersFromRooms(rooms, servers);
    }).done(function() {
        log.info("Finished syncing membership lists.");
    }, function(err) {
        log.error("Failed to sync membership lists: %s", err);
    });
};

// grab all rooms the bot knows about which have at least 1 real user in them.
function getSyncableRooms(servers) {
    var mxLib = matrixLib.getMatrixLibFor();
    var defer = q.defer();
    // hit /initialSync on the bot to pull in room state for all rooms.
    mxLib.initialSync().done(function(res) {
        var rooms = res.rooms || [];
        rooms = rooms.map(function(room) {
            return getRoomMemberData(servers, room.room_id, room.state);
        });
        // filter out rooms with no real matrix users in them.
        rooms = rooms.filter(function(room) {
            return room.reals.length > 0;
        });
        defer.resolve(rooms);
    });

    return defer.promise;
}

function joinBotToChannels(rooms, channels) {
    return q();
}

function joinMatrixUsersToChannels(rooms, channels) {
    return q();
}

function joinIrcUsersToRooms(rooms, channels) {
    return q();
}

function leaveIrcUsersFromRooms(rooms, channels) {
    return q();
}

function getRoomMemberData(servers, roomId, stateEvents) {
    stateEvents = stateEvents || [];
    var i;
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
        // check if they are virtual
        var isVirtual = false;
        for (i = 0; i < servers.length; i++) {
            if (servers[i].claimsUserId(userId)) {
                isVirtual = true;
                break;
            }
        }
        if (isVirtual) {
            data.virtuals.push(userId);
        }
        else {
            data.reals.push(userId);
        }
    });
    return data;
}
