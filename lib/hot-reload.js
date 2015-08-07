"use strict";
var PID_FILENAME = "ircas.pid";
var fs = require("fs");
var q = require("q");
var logging = require("./logging");
var Validator = require("./config/validator");
var log = logging.get("hotreload");

var reloading = false;

var reloadConfig = function() {
    log.info("Reloading config file....");
    var config;
    try {
        var configValidator = new Validator(Validator.getFileLocation());
        config = configValidator.validate();
    }
    catch (e) {
        log.error("Failed to load config file: " + e);
        return q.reject();
    }
    log.info("Loaded config file.");
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
