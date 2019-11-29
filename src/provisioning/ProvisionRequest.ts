import logging, { RequestLogger, newRequestLogger } from "../logging";
import crypto from "crypto";
import { Request } from "express";
const rootLogger = logging("ProvisionRequest");

export class ProvisionRequest {
    private id: string;
    public log: RequestLogger;
    constructor(private req: Request, fnName: string) {
        this.id = crypto.randomBytes(4).toString('hex');
        this.log = newRequestLogger(rootLogger, `${this.id} ${fnName}`, false);
    }

    get body () {
        return this.req.body;
    }

    get params () {
        return this.req.params;
    }

    public static createFake(fnName: string, log: RequestLogger) {
        // This is a DANGEROUS operation, used to create a fake request object
        // to make internal requests to the provisioner.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = new ProvisionRequest(null as any, fnName);
        r.log = log;
        return r;
    }
}
