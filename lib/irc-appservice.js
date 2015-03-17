/*
 * Main entry point for this service.
 */
"use strict";
module.exports.serviceName = "matrix-appservice-irc";

var bridge = require("./bridge.js");
var IrcServer = require("./irclib/server.js").IrcServer;
var ircLib = require("./irclib/irc.js");
var matrixLib = require("./mxlib/matrix");
var servers = [];

module.exports.configure = function(opts) {
    /*
    Format:
    {
        servers: {
            "server.domain.com": {
                nick: "BotNick",
                expose: {
                    channels: true,
                    privateMessages: false
                },
                rooms: {
                    mappings: {
                        "#specific-channel": ["!room1:matrix.org", "!room2:matrix.org"],
                    },
                    aliasPrefix: "#irc_",
                    exclude: [ "#foo", "#bar" ]
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
            var server = new IrcServer(
                serverDomains[i], opts.servers[serverDomains[i]]
            );
            bridge.store.setRoomsFromConfig(
                server, opts.servers[serverDomains[i]]
            );
            servers.push(server);
        }
    }
    if (servers.length == 0) {
        throw new Error("No servers specified.");
    }
    ircLib.setServers(servers);
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
    ircLib.registerHooks({
        onMessage: bridge.hooks.irc.onMessage
    });
    ircLib.connect();
};