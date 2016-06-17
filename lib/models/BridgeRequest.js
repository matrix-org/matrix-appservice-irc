"use strict";
var logging = require("../logging");
var log = logging.get("req");

class BridgeRequest {
    constructor(req, isFromIrc) {
        this.isFromIrc = isFromIrc;
        this.req = req;
        this.log = logging.newRequestLogger(log, req.getId(), isFromIrc);
    }

    getPromise() {
        return this.req.getPromise();
    }

    resolve(thing) {
        this.req.resolve(thing);
    }

    reject(err) {
        this.req.reject(err);
    }
}
BridgeRequest.ERR_VIRTUAL_USER = "virtual-user";
BridgeRequest.ERR_NOT_MAPPED = "not-mapped";

module.exports = BridgeRequest;
