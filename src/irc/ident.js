/*
 * Runs an ident server to auth a list of usernames.
 *
 * This purposefully has no dependencies on any other library and is kept as
 * generic as possible. It consists of three functions:
 *
 * configure(opts) : opts => { port: {Number} }
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

var config = {
    port: 113,
    address: "0.0.0.0"
};
var portMappings = {
    // port: username
};

var respond = function(sock, localPort, remotePort, username) {
    var response;
    if (username) {
        response = localPort + "," + remotePort + ":USERID:UNIX:" + username;
    }
    else {
        response = localPort + "," + remotePort + ":ERROR:NO-USER";
    }
    response += "\r\n";

    log.debug(response);
    sock.end(response);
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
                log.debug("DATA " + data);
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
            sock.on("error", function(err) {
                log.error("connection error: " + err);
                if (err && err.stack) {
                    log.error(err.stack);
                }
            });
        }).listen(config.port, config.address);
    },
    setMapping: function(username, port) {
        if (port) {
            portMappings[port] = username;
            log.debug("Set user %s on port %s", username, port);
        }
        else if (port === 0) {
            Object.keys(portMappings).forEach(function(portNum) {
                if (portMappings[portNum] === username) {
                    portMappings[portNum] = undefined;
                    log.debug("Remove user %s from port %s", username, portNum);
                }
            });
        }
    }
};
