"use strict";
module.exports.serviceName = "matrix-appservice-irc";

var core = require("./core.js");
var IrcServer = require("./server.js").IrcServer;
var servers = [];
var q = require("q");

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
    /*
    Format:
    {
        servers: {
            "server.domain.com": {
                nick: "BotNick",
                rooms: {
                    "#specific-channel": ["!room1:matrix.org", "!room2:matrix.org"],
                    "*": "#irc_"  // catch-all prefix, if this is missing, other 
                                  // channels aren't passed in 
                }
            },
            "another.server.com": {
                ...
            }
        }
    }
    */
    if (opts.servers) {
        var serverDomains = Object.keys(opts.servers);
        for (var i=0; i<serverDomains.length; i++) {
            servers.push(
                new IrcServer(serverDomains[i], opts.servers[serverDomains[i]])
            );
        }
    }
    if (servers.length == 0) {
        throw new Error("No servers specified.");
    }
};

module.exports.register = function(controller) {
    controller.setAliasQueryResolver(aliasHandler);
    controller.setUserQueryResolver(userHandler);
    for (var i=0; i<servers.length; i++) {
        var server = servers[i];
        if (server.shouldMapAllRooms()) {
            controller.addRegexPattern(
                "aliases", "#"+server.aliasPrefix+".*", true
            );
        }
        controller.addRegexPattern(
            "users", "@"+server.userPrefix+".*", true
        );
    }
    controller.on("type:m.room.message", handleText);
    controller.on("type:m.room.member", function(event) {
        if (event.content && event.content.membership === "invite") {
            handleInvite(event);
        }
    });
};