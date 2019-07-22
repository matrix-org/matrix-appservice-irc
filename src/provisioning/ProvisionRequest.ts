import crypto from "crypto";
import logging, { ILogger } from "../logging";

const log = logging.get("ProvisionRequest");

export class ProvisionRequest {
    private id: string;
    public log: ILogger;
    public params: {[key: string]: string};
    public body: string;
    constructor(public req: any, fnName: string) {
        this.req = req;
        this.body = req.body;
        this.params = req.params;
        this.id = crypto.randomBytes(4).toString('hex');
        this.log = logging.newRequestLogger(log, `${this.id} ${fnName}`, false);
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