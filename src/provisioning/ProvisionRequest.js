"use strict";
const logging = require("../logging");
var log = logging.get("ProvisionRequest");
const crypto = require('crypto');

class ProvisionRequest {
    constructor(req, fnName) {
        this.req = req;
        this.body = req.body;
        this.params = req.params;
        this._id = crypto.randomBytes(4).toString('hex');
        this.log = logging.newRequestLogger(log, this._id + ' ' + fnName, false);
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
module.exports = ProvisionRequest;
