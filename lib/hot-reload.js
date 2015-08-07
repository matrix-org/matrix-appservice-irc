"use strict";
var PID_FILENAME = "ircas.pid";
var fs = require("fs");


var reloadConfig = function() {
    console.log("Got signal");
};

module.exports.setup = function() {
    // write out the pid file
    fs.writeFileSync(PID_FILENAME, "" + process.pid);

    // SIGUSR1 is reserved by node for debugging
    process.on("SIGUSR2", reloadConfig);
};
