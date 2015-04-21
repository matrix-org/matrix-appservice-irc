/*
 * Runs an ident server to auth a list of usernames.
 *
 * This purposefully has no dependencies on any other library and is kept as
 * generic as possible. It consists of three functions:
 *
 * configure(opts) : opts => { port: {Number}, hashUsernames: {Boolean} }
 *      Configure the ident server.
 *
 * run()
 *      Start listening on the configured port for incoming requests.
 *
 * setMapping(username, port) : username => {String}, port => {Number}
 *      Assign a username/port mapping. Setting a port of 0 removes the mapping.
 */
"use strict";
var net = require('net');

var log = require("../logging").get("irc-ident");
// TODO:
// - username hashing
// - removing mappings
var config = {
    port: 113,
    hashUsernames: false
};
var portMappings = {
    // port: username
};

var respond = function(sock, localPort, remotePort, username) {
    if (username) {
        sock.end(localPort+", "+remotePort+" : USERID : UNIX : "+username);
    }
    else {
        sock.end(localPort+", "+remotePort+" : ERROR : NO-USER");
    }
};

module.exports = {
    configure: function(opts) {
        log.info("Configuring ident server => %s", JSON.stringify(opts));
        config = opts;
    },
    run: function() {
        net.createServer(function(sock) {
            log.debug("CONNECT %s %s", sock.remoteAddress, sock.remotePort);
            sock.on("data", function(data) {
                log.debug("DATA "+data);
                var ports = data.toString().split(",");
                var remoteConnectPort = Number(ports[1]);
                var localOutgoingPort = Number(ports[0]);
                if (!remoteConnectPort || !localOutgoingPort) {
                    log.debug("BAD DATA");
                    return;
                }
                var username = portMappings[String(localOutgoingPort)];
                if (!username) {
                    log.debug("No user on port %s", localOutgoingPort);
                    respond(sock, localOutgoingPort, remoteConnectPort, null);
                    return;
                }
                log.debug("Port %s is %s", localOutgoingPort, username);
                respond(sock, localOutgoingPort, remoteConnectPort, username);
            });
            sock.on("close", function() {
                log.debug("CLOSE");
            });
        }).listen(config.port, "0.0.0.0");
    },
    setMapping: function(username, port) {
        if (port) {
            portMappings[port] = username;
        }
    }
};