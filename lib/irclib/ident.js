/*
 * Runs an ident server to auth usernames for IRC clients.
 */
"use strict";
var log = require("../logging").get("irc-ident");

module.exports.configure = function(config) {
    log.info("Configuring ident server => %s", JSON.stringify(config));
};