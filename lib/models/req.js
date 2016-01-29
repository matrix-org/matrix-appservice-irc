var matrixLib = require("../mxlib/matrix");
var ircLib = require("../irclib/irc");
var logging = require("../logging");
var log = logging.get("req");

class BridgeRequest {
    constructor(req, isFromIrc) {
        this.isFromIrc = isFromIrc;
        this.req = req;
        this.log = logging.newRequestLogger(log, req.getId(), isFromIrc);
        this.mxLib = matrixLib.getMatrixLibFor(this);
        this.ircLib = ircLib.getIrcLibFor(this);
    }

    resolve(thing) {
        this.req.resolve(thing);
    }

    reject(err) {
        this.req.reject(err);
    }
}
BridgeRequest.ERR_VIRTUAL_USER = Symbol("virtual-user");

module.exports = BridgeRequest;
