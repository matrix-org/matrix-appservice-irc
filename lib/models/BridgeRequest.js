"use strict";
var logging = require("../logging");
var log = logging.get("req");
class BridgeRequest {
    constructor(req) {
        this.req = req;
        var isFromIrc = req.getData() ? Boolean(req.getData().isFromIrc) : false;
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
BridgeRequest.ERR_DROPPED = "dropped";
module.exports = BridgeRequest;
