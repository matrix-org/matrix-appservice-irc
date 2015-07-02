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
    log.info("Checking membership lists for syncing");

};
