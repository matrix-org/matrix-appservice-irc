"use strict";
var log = require("./logging").get("DebugApi");
var http = require("http");

function DebugApi(port, servers, pool) {
    this.port = port;
    this.pool = pool;
    this.servers = servers;
}

DebugApi.prototype.getClientState = function(server, user) {
    log.debug("getClientState(%s,%s)", server.domain, user);
    let client = null;
    if (!user) {
        client = this.pool.getBot(server);
    }
    else {
        client = this.pool.getBridgedClientByUserId(server, user);
    }
    if (!client) {
        return "User " + user + " does not have a client on " + server.domain;
    }
    return require("util").inspect(client, {colors:true, depth:null});
};

DebugApi.prototype.sendIRCCommand = function(server, user, body) {
    log.debug("sendIRCCommand(%s,%s,%s)", server.domain, user, body);
}

DebugApi.prototype.run = function() {
    log.info("DEBUG API LISTENING ON :%d", this.port);

    http.createServer((req, response) => {
        log.debug(req.method + " " + req.url);

        // Looks like /irc/$domain/user/$user_id
        let segs = req.url.split("/");
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
            try {
                let resBody = "\n";
                if (req.method === "GET") {
                    resBody = this.getClientState(server, user);
                }
                else if (req.method === "POST") {
                    resBody = this.sendIRCCommand(server, user, body);
                }
                response.writeHead(200, {"Content-Type": "text/plain"});
                response.write("" + resBody);
            }
            catch (err) {
                response.writeHead(500, {"Content-Type": "text/plain"});
                response.write("" + err);
            }
            response.end();
        });
    }).listen(this.port);
}

module.exports = DebugApi;
