"use strict";
module.exports.serviceName = "matrix-appservice-irc";

var core = require("./core.js");
var q = require("q");
var config = {};

var aliasHandler = function(roomAlias) {
    // TODO: Handle room alias query
    return q.reject({});
};

var userHandler = function(userId) {
    // TODO: Handle user query
    return q.reject({});
};

var handleText = function(event) {
    console.log("RECV %s", JSON.stringify(event));
};

var handleInvite = function(event) {
    console.log("handleInvite: %s", JSON.stringify(event));
};

module.exports.configure = function(opts) {
    config = opts;
};

module.exports.register = function(controller) {
    controller.setAliasQueryResolver(aliasHandler);
    controller.setUserQueryResolver(userHandler);
    controller.addRegexPattern("aliases", "#irc_.*", false);
    controller.on("type:m.room.message", handleText);
    controller.on("type:m.room.member", function(event) {
        if (event.content && event.content.membership === "invite") {
            handleInvite(event);
        }
    });
};