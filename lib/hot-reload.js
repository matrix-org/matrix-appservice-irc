"use strict";
var PID_FILENAME = "ircas.pid";
var fs = require("fs");
var q = require("q");
var logging = require("./logging");
var log = logging.get("hotreload");

var reloading = false;

var reloadConfig = function() {
    log.info("Reloading config file....");
    return q();
};

module.exports.setup = function() {
    // write out the pid file
    fs.writeFileSync(PID_FILENAME, "" + process.pid);

    // SIGUSR1 is reserved by node for debugging
    process.on("SIGUSR2", function() {
        log.info("SIGUSR2 received.");
        if (!reloading) {
            log.info(" @@@@@@@@@@ HOT RELOAD @@@@@@@@@@ ");
            reloading = true;
            reloadConfig().finally(function() {
                reloading = false;
            });
        }
    });
};
