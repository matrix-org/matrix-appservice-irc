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

const EventEmitter = require('events');
const net = require('net');

const log = require("../logging").get("irc-ident");

var config = {
    port: 113,
    address: "0.0.0.0"
};
var portMappings = {
    // port: username
};

var nextToken = 1;
const openTokens = [];
const emitter = new EventEmitter();

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

const tryRespond = (currentToken, sock, localPort, remotePort) => {
    let username = portMappings[localPort];
    if (username) {
        log.debug("Port %s is %s", localPort, username);
        respond(sock, localPort, remotePort, username);
    }
    else if (openTokens.length > 0 && openTokens[0] < currentToken) {
        emitter.once("token", () => tryRespond(currentToken, sock, localPort, remotePort));
    }
    else {
        log.debug("No user on port %s", localPort);
        respond(sock, localPort, remotePort, null);
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
                log.debug("DATA " + data);
                var ports = data.toString().split(",");
                var remoteConnectPort = Number(ports[1]);
                var localOutgoingPort = Number(ports[0]);
                if (!remoteConnectPort || !localOutgoingPort) {
                    log.debug("BAD DATA");
                    return;
                }
                tryRespond(nextToken, sock,
                    String(localOutgoingPort),
                    String(remoteConnectPort));
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
    },
    takeToken: function() {
        let token = nextToken++;
        openTokens.push(token);
        log.debug("Took token %d", token);
        return token;
    },
    returnToken: function(token) {
        let index = openTokens.indexOf(token);
        if (index > -1) {
            openTokens.splice(index, 1);
            log.debug("Returned token %d", token);
            emitter.emit('token');
        }
    }
};
