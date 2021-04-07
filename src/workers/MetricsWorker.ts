import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import { createServer, ServerResponse } from "http";
import { Registry, Gauge } from "prom-client";
import getLog from "../logging";
const METRICS_DUMP_TIMEOUT_MS = 20000;

function writeLog(level: string, msg: string) {
    return parentPort?.postMessage(`log:${level}:${msg}`);
}

function workerThread() {
    let lastDumpTs = Date.now();

    const registry = new Registry();
    const intervalCounter = new Gauge({
        name: "metrics_worker_interval",
        help: "Interval time for metrics being reported to the metrics worker process",
        registers: [registry]
    });

    if (!parentPort) {
        throw Error("Missing parentPort");
    }

    const writeAndEnd = (res: ServerResponse, data: string) => {
        if (res.writable) {
            res.write(data);
        }
        if (!res.finished) {
            res.end();
        }
    }

    createServer((req, res) => {
        res.setHeader("Content-Type", "text/plain");
        if (!req.url || req.url !== "/metrics" || req.method !== "GET") {
            res.statusCode = 404;
            res.write('Path or method not known');
            res.end();
            return;
        }
        writeLog("debug", "Request for /metrics");
        const timeout = setTimeout(async () => {
            intervalCounter.inc(METRICS_DUMP_TIMEOUT_MS);
            res.statusCode = 200;
            res.writeHead(200);
            writeAndEnd(res, await registry.metrics());
        }, METRICS_DUMP_TIMEOUT_MS)

        // We've checked for the existence of parentPort above.

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        parentPort!.once("message", async (msg: string) => {
            clearTimeout(timeout);
            const time = Date.now();
            intervalCounter.set(time - lastDumpTs);
            lastDumpTs = time;
            const dump = msg.substring('metricsdump:'.length);
            if (res.finished) {
                // Sometimes a message will come in far too late because we've already
                // sent an empty response. Drop it here.
                return;
            }
            res.writeHead(200);
            writeAndEnd(res, `${dump}\n${await registry.metrics()}`);
        });

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        parentPort!.postMessage("metricsdump");
    }).listen(workerData.port, workerData.hostname, 1);
}

export function spawnMetricsWorker(port: number, hostname = "127.0.0.1", onMetricsRequested: () => Promise<string>) {
    const worker = new Worker(__filename, { workerData: { port, hostname } });
    const workerLogger = getLog("MetricsWorker");
    worker.on("message", async (msg: string) => {
        if (msg === "metricsdump") {
            worker.postMessage("metricsdump:" + await onMetricsRequested());
        }
        else if (msg.startsWith("log")) {
            const [, logLevel, logMsg] = msg.split(":");
            workerLogger.log(logLevel, logMsg, { loggerName: "MetricsWorker" });
        }
    })
    return worker;
}

if (!isMainThread) {
    workerThread();
}
