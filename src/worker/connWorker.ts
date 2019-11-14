/**
 * This is an *experimental* worker app which shards connection handling
 * into a subprocess of the master app.
 */

import { isMainThread, workerData, parentPort, MessagePort, Worker } from "worker_threads";
import getLogger from "../logging";
import { BridgeConfig } from "../config/BridgeConfig";
import { ClientPool } from "../irc/ClientPool";
import { IrcBridge } from "../bridge/IrcBridge";

const log = getLogger("ConnectionWorker");

export class ConnectionWorker {
    private opts?: ConnectionWorkerOpts;
    private port?: MessagePort;
    private worker?: Worker;
    constructor() {
        if (isMainThread) {
            return;
        }
        this.opts = workerData as ConnectionWorkerOpts;
        if (!parentPort) {
            throw Error("Parent port not accessible");
        }
        this.port = parentPort;
        this.port.on("message", (_msg) => {
            const msg = _msg as ConnectionWorkerRPC;
            log.debug("got message", msg);
        });
        this.port.on("close", () => {
            log.warn("closing");
        });
    }

    public async runWorker() {
        if (!this.opts) {
            throw Error("runWorker should be run on the worker side");
        }
        const datastore = IrcBridge.createDatastore(this.opts.config);
        const clientPool = new ClientPool(, datastore);
    }

    public spawnWorker(opts: ConnectionWorkerOpts) {
        this.worker = new Worker(__filename, {
            workerData: opts,
        });
        this.worker.on("exit", (code) => {
            log.warn(`Worker exited with code ${code}`);
        });
        this.worker.on("error", (error) => {
            log.error(`Worker had an error: ${error}`);
        });
        this.worker.on("message", (_msg) => {
            const msg = _msg as ConnectionWorkerRPC;
            log.debug("got message", msg);
        });
        log.info("Spawned new connection worker %d", this.worker.threadId);
    }

    public sendRPC(rpc: ConnectionWorkerRPC) {
        const conn = this.worker||this.port;
        if (!conn) {
            throw Error("Worker not started");
        }
        conn.postMessage(rpc);
    }
}

if (!isMainThread) {
    new ConnectionWorker().runWorker();
}

export interface ConnectionWorkerOpts {
    config: BridgeConfig;
}

export interface ConnectionWorkerRPC {

}