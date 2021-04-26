import logging, { RequestLogger, newRequestLogger } from "../logging";
import crypto from "crypto";
const rootLogger = logging("ProvisionRequest");

export class ProvisionRequest {
    private id: string;
    public log: RequestLogger;
    constructor(private req: { body: Record<string, string>, params: Record<string, string> }, fnName: string) {
        this.id = crypto.randomBytes(4).toString('hex');
        this.log = newRequestLogger(rootLogger, `${this.id} ${fnName}`, false);
    }

    get body () {
        return this.req.body;
    }

    get params () {
        return this.req.params;
    }

    public static createFake(fnName: string, log: RequestLogger, body: Record<string, string> = {}) {
        // This is a DANGEROUS operation, used to create a fake request object
        // to make internal requests to the provisioner.
        const r = new ProvisionRequest({
            body,
            params: {},
        }, fnName);
        r.log = log;
        return r;
    }
}
