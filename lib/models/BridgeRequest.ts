import * as logging from "../logging";
import { IRequestLogger } from "../logging";

const log = logging.get("req");
export class BridgeRequest {

    public static ERR_VIRTUAL_USER = "virtual-user";
    public static ERR_NOT_MAPPED = "not-mapped";
    public static ERR_DROPPED = "dropped";

    public readonly isFromIrc: boolean;
    public readonly log: IRequestLogger;

    constructor (private req) {
        this.isFromIrc = req.getData() ? Boolean(req.getData().isFromIrc) : false;
        this.log = logging.newRequestLogger(log, req.getId(), this.isFromIrc);
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