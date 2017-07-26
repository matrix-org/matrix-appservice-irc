"use strict";
var querystring = require("querystring");
var Promise = require("bluebird");
var BridgeRequest = require("./models/BridgeRequest");
var log = require("./logging").get("DebugApi");
var http = require("http");

function DebugApi(ircBridge, port, servers, pool, token) {
    this.ircBridge = ircBridge;
    this.port = port;
    this.pool = pool;
    this.servers = servers;
    this.token = token;
}

DebugApi.prototype._getClient = function(server, user) {
    if (!user) {
        return this.pool.getBot(server);
    }
    return this.pool.getBridgedClientByUserId(server, user);
};

DebugApi.prototype.getClientState = function(server, user) {
    log.debug("getClientState(%s,%s)", server.domain, user);
    let client = this._getClient(server, user);
    if (!client) {
        return "User " + user + " does not have a client on " + server.domain;
    }
    return require("util").inspect(client, {colors:true, depth:7});
};

DebugApi.prototype.killUser = function(userId, reason) {
    const req = new BridgeRequest(this.ircBridge._bridge.getRequestFactory().newRequest());
    const clients = this.pool.getBridgedClientsForUserId(userId);
    return this.ircBridge.matrixHandler.quitUser(req, userId, clients, null, reason);
};

// returns a promise to allow a response buffer to be populated
DebugApi.prototype.sendIRCCommand = function(server, user, body) {
    log.debug("sendIRCCommand(%s,%s,%s)", server.domain, user, body);
    let client = this._getClient(server, user);
    if (!client) {
        return Promise.resolve(
            "User " + user + " does not have a client on " + server.domain + "\n"
        );
    }
    if (!client.unsafeClient) {
        return Promise.resolve(
            "There is no underlying client instance.\n"
        );
    }

    // store all received response strings
    let buffer = [];
    let listener = function(msg) {
        buffer.push(JSON.stringify(msg));
    }

    client.unsafeClient.on("raw", listener);
    // turn rn to n so if there are any new lines they are all n.
    body = body.replace("\r\n", "\n");
    body.split("\n").forEach((c) => {
        // IRC protocol require rn
        client.unsafeClient.conn.write(c + "\r\n");
        buffer.push(c);
    });

    // wait 3s to pool responses
    return Promise.delay(3000).then(function() {
        // unhook listener to avoid leaking
        if (client.unsafeClient) {
            client.unsafeClient.removeListener("raw", listener);
        }
        return buffer.join("\n") + "\n";
    });
}

DebugApi.prototype.run = function() {
    log.info("DEBUG API LISTENING ON :%d", this.port);

    http.createServer((req, response) => {
        try {
            let reqPath = req.url.split("?");
            let path = reqPath[0];
            let query = querystring.parse(reqPath[1]);
            log.debug(req.method + " " + path);

            if (query["access_token"] !== this.token) {
                response.writeHead(403, {"Content-Type": "text/plain"});
                response.write("Invalid or missing ?access_token=. " +
                    "The app service token is required from the registration.\n");
                response.end();
                log.warn("Failed attempt with token " + query["access_token"]);
                return;
            }

            if (path == "/killUser") {
                let body = "";
                req.on("data", function(chunk) {
                    body += chunk;
                });
                req.on("end", () => {
                    let promise = null;
                    try {
                        body = JSON.parse(body);
                        if (!body.user_id || !body.reason) {
                            promise = Promise.reject(new Error("Need user_id and reason"));
                        }
                        else {
                            promise = this.killUser(body.user_id, body.reason);
                        }
                    }
                    catch (err) {
                        promise = Promise.reject(err);
                    }

                    promise.then(function(r) {
                        response.writeHead(200, {"Content-Type": "text/plain"});
                        response.write(r + "\n");
                        response.end();
                    }, function(err) {
                        log.error(err.stack);
                        response.writeHead(500, {"Content-Type": "text/plain"});
                        response.write(err + "\n");
                        response.end();
                    });
                });
                return;
            }

            // Looks like /irc/$domain/user/$user_id
            let segs = path.split("/");
            if (segs.length !== 5 || segs[1] !== "irc" || segs[3] !== "user") {
                response.writeHead(404, {"Content-Type": "text/plain"});
                response.write("Not a valid debug path.\n");
                response.end();
                return;
            }

            let domain = segs[2];
            let user = segs[4];

            log.debug("Domain: %s User: %s", domain, user);

            let server = null;
            for (var i = 0; i < this.servers.length; i++) {
                if (this.servers[i].domain === domain) {
                    server = this.servers[i];
                    break;
                }
            }
            if (server === null) {
                response.writeHead(400, {"Content-Type": "text/plain"});
                response.write("Not a valid domain.\n");
                response.end();
                return;
            }

            let body = "";
            req.on("data", function(chunk) {
                body += chunk;
            });

            req.on("end", () => {
                // Create a promise which resolves to a response string
                let promise = null;
                if (req.method === "GET") {
                    try {
                        let resBody = this.getClientState(server, user);
                        if (!resBody.endsWith("\n")) {
                            resBody += "\n";
                        }
                        promise = Promise.resolve(resBody);
                    }
                    catch (err) {
                        promise = Promise.reject(err);
                    }
                }
                else if (req.method === "POST") {
                    promise = this.sendIRCCommand(server, user, body)
                }
                else {
                    promise = Promise.reject(new Error("Bad HTTP method"));
                }

                promise.done(function(r) {
                    response.writeHead(200, {"Content-Type": "text/plain"});
                    response.write(r);
                    response.end();
                }, function(err) {
                    log.error(err.stack);
                    response.writeHead(500, {"Content-Type": "text/plain"});
                    response.write(err + "\n");
                    response.end();
                });
            });
        }
        catch (err) {
            log.error(err.stack);
        }
    }).listen(this.port);
}

module.exports = DebugApi;
