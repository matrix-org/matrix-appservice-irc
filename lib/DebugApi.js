"use strict";
var log = require("./logging").get("DebugApi");
var http = require("http");

function DebugApi(port) {
    this.port = port;
}

DebugApi.prototype.getClientState = function(domain, user) {
    log.debug("getClientState(%s,%s)", domain, user);
};

DebugApi.prototype.sendIRCCommand = function(domain, user, body) {
    log.debug("sendIRCCommand(%s,%s,%s)", domain, user, body);
}

DebugApi.prototype.run = function() {
    log.info("DEBUG API LISTENING ON :%d", this.port);

    http.createServer((req, response) => {
        log.debug(req.method + " " + req.url);

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

        let body = "";
        req.on("data", function(chunk) {
            body += chunk;
        });

        req.on("end", () => {
            try {
                let resBody = "\n";
                if (req.method === "GET") {
                    resBody = this.getClientState(domain, user);
                }
                else if (req.method === "POST") {
                    resBody = this.sendIRCCommand(domain, user, body);
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
