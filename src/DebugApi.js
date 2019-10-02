/*eslint no-invalid-this: 0*/ // eslint doesn't understand Promise.coroutine wrapping
"use strict";
const querystring = require("querystring");
const Promise = require("bluebird");
const { BridgeRequest } = require("./models/BridgeRequest");
const log = require("./logging").get("DebugApi");
const http = require("http");

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
            else if (req.method === "POST" && path == "/reapUsers") {
                const msgCb = (msg) => {
                    if (!response.headersSent) {
                        response.writeHead(200, {"Content-Type": "text/plain"});
                    }
                    response.write(msg + "\n")
                }
                this.ircBridge.connectionReap(
                    msgCb, query["server"], parseInt(query["since"]), query["reason"]
                ).catch((err) => {
                    log.error(err.stack);
                    if (!response.headersSent) {
                        response.writeHead(500, {"Content-Type": "text/plain"});
                    }
                    response.write(err + "\n");
                }).finally(() => {
                    response.end();
                });
                return;
            }
            else if (req.method === "POST" && path == "/killPortal") {
                this.killPortal(req, response);
                return;
            }
            else if (req.method === "GET" && path === "/inspectUsers") {
                this.inspectUsers(query["regex"], response);
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

DebugApi.prototype.killPortal = Promise.coroutine(function*(req, response) {
    const result = {
        error: [], // string|[string] containing a fatal error or minor errors.
        stages: [] // stages completed for removing the room. It's possible it might only
                   // half complete, and we should make that obvious.
    };
    const body = yield this._wrapJsonReq(req, response);

    // Room room_id to lookup and delete the alias from.
    const roomId = body["room_id"];

    // IRC server domain
    const domain = body["domain"];

    // IRC channel
    const channel = body["channel"];

    // Should we tell the room about the deletion. Defaults to true.
    const notice = !(body["leave_notice"] === false);

    // Should we remove the alias from the room. Defaults to true.
    const remove_alias = !(body["remove_alias"] === false);

    // These keys are required.
    ["room_id", "channel", "domain"].forEach((key) => {
        if (typeof(body[key]) !== "string") {
            result.error.push(`'${key}' is missing from body or not a string`);
        }
    });
    if (result.error.length > 0) {
        this._wrapJsonResponse(result.error, false, response);
        return;
    }

    log.warn(
`Requested deletion of portal room alias ${roomId} through debug API
Domain: ${domain}
Channel: ${channel}
Leave Notice: ${notice}
Remove Alias: ${remove_alias}`);

    // Find room
    let room = yield this.ircBridge.getStore().getRoom(
        roomId,
        domain,
        channel,
        "alias"
    );
    if (room === null) {
        result.error = "Room not found";
        this._wrapJsonResponse(result, false, response);
        return;
    }

    const server = this.servers.find((srv) => srv.domain === domain);
    if (server === null) {
        result.error = "Server not found!";
        this._wrapJsonResponse(result, false, response);
        return;
    }

    // Drop room from room store.
    yield this.ircBridge.getStore().removeRoom(
        roomId,
        domain,
        channel,
        "alias"
    );
    result.stages.push("Removed room from store");

    if (notice) {
        try {
            yield this.ircBridge.getAppServiceBridge().getIntent().sendEvent(roomId, "notice",
            {
                body: `This room has been unbridged from ${channel} (${server.getReadableName()})`
            });
            result.stages.push("Left notice in room");
        }
        catch (e) {
            result.error.push("Failed to send a leave notice");
        }
    }

    if (remove_alias) {
        const roomAlias = server.getAliasFromChannel(channel);
        try {
            yield this.ircBridge.getAppServiceBridge().getIntent().client.deleteAlias(roomAlias);
            result.stages.push("Deleted alias for room");
        }
        catch (e) {
            result.error.push("Failed to remove alias");
        }
    }

    // Drop clients from room.
    // The provisioner will only drop clients who are not in other rooms.
    // It will also leave the MatrixBot.
    try {
        yield this.ircBridge.getProvisioner()._leaveIfUnprovisioned(
            { log: log },
            roomId,
            server,
            channel
        );
    }
    catch (e) {
        result.error.push("Failed to leave users from room");
        result.error.push(e);
        this._wrapJsonResponse(result, false, response);
        return;
    }

    result.stages.push("Parted clients where applicable.");
    this._wrapJsonResponse(result, true, response);
});

DebugApi.prototype.inspectUsers = function(regex, response) {
    if (!regex) {
        this._wrapJsonResponse({
            "error": "'regex' not provided",
        }, false, response);
        return;
    }
    try {
        const userClients = this.ircBridge.getBridgedClientsForRegex(regex);
        const clientsResponse = {};
        Object.keys(userClients).forEach((userId) => {
            clientsResponse[userId] = userClients[userId].map((client) => {
                if (!client) {
                    return undefined;
                }
                return {
                    channels: client.chanList,
                    dead: client.isDead(),
                    server: client.server.domain,
                    nick: client.nick,
                };
            });
        });
        this._wrapJsonResponse({
            users: clientsResponse,
        }, true, response);
    }
    catch (ex) {
        this._wrapJsonResponse({
            "error": "Failed to fetch clients for user",
            "info": String(ex),
        }, false, response);
    }
};

DebugApi.prototype._wrapJsonReq = function(req, response) {
    let body = "";
    req.on("data", function(chunk) {
        body += chunk;
    });
    return new Promise((resolve, reject) => {
        req.on("error", (err) => {
            reject(err);
        });
        req.on("end", () => {
            if (body === "") {
                reject({"error": "Body missing"});
            }
            try {
                body = JSON.parse(body);
                resolve(body);
            }
            catch (err) {
                reject(err);
            }
        });
    });
}

DebugApi.prototype._wrapJsonResponse = function(json, isOk, response) {
    response.writeHead(isOk === true ? 200 : 500, {"Content-Type": "application/json"});
    response.write(JSON.stringify(json));
    response.end();
}

module.exports = DebugApi;
