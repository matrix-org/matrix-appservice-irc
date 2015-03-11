"use strict";
module.exports.serviceName = "matrix-appservice-irc";

var bridge = require("./bridge.js");
var IrcServer = require("./irclib/server.js").IrcServer;
var ircServerPool = require("./irclib/server-pool.js");
var matrixLib = require("./mxlib/matrix");
var servers = [];

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
            // TODO: If a Matrix user joins a dynamic IRC channel (lazy loaded 
            // from an alias query), then we need to add those channel/room ID
            // combos to the "rooms" section for that server. This won't be
            // specified in the config, so we need to grab that from a database:
            //   server.getChannelToRoomList() -> {
            //     "#alpha": ["!generatedFromRoomAliasQuery:matrix.org"] 
            //   }
            // then mux that in with the server config.
            servers.push(
                new IrcServer(serverDomains[i], opts.servers[serverDomains[i]])
            );
        }
    }
    if (servers.length == 0) {
        throw new Error("No servers specified.");
    }
    ircServerPool.setServers(servers);
};

module.exports.register = function(controller, serviceConfig) {
    controller.setAliasQueryResolver(bridge.hooks.matrix.onAliasQuery);
    controller.setUserQueryResolver(bridge.hooks.matrix.onUserQuery);
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
    controller.on("type:m.room.message", bridge.hooks.matrix.onMessage);
    controller.on("type:m.room.member", function(event) {
        if (event.content && event.content.membership === "invite") {
            bridge.hooks.matrix.onInvite(event);
        }
    });
    matrixLib.setMatrixClientConfig({
        baseUrl: serviceConfig.hs,
        accessToken: serviceConfig.token,
        domain: serviceConfig.hsDomain
    });
    ircServerPool.registerHooks({
        onMessage: bridge.hooks.irc.onMessage
    });
    ircServerPool.connect();
};