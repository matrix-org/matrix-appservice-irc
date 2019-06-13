import { default as logging, ILogger } from "../logging";

const log = logging.get("req");
export class BridgeRequest {

    public static ERR_VIRTUAL_USER = "virtual-user";
    public static ERR_NOT_MAPPED = "not-mapped";
    public static ERR_DROPPED = "dropped";

    public readonly isFromIrc: boolean;
    public readonly log: ILogger;

    constructor (private req: any) {
        this.isFromIrc = req.getData() ? Boolean(req.getData().isFromIrc) : false;
        this.log = logging.newRequestLogger(log, req.getId(), this.isFromIrc);
    }
    
    getPromise() {
        return this.req.getPromise();
    }

    resolve(thing: any) {
        this.req.resolve(thing);
    }

    reject(err: any) {
        this.req.reject(err);
    }
}