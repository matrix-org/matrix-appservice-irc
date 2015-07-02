// Controls the logic for determining which membership lists should be synced and
// handles the sequence of events until the lists are in sync.
"use strict";

//var bridge = require("./bridge.js");
var ircLib = require("./irclib/irc.js");
//var matrixLib = require("./mxlib/matrix");
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
    // TODO: If we inject into the bridge; won't this break if they don't mirror
    // join parts? Clobber it?

    // TODO: More complicated rulesets other than 'global'.

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
    getSyncableRooms();
};

function getSyncableRooms() {
    // * hit /initialSync on the bot to pull in room state for all rooms.
    // * filter out non-synced rooms (according to config rules).
    // * filter out virtual users we made. Get the real ones only.
    // * return rooms (with members split into virtual/real) which have at
    //   least one real matrix user in them.
}
