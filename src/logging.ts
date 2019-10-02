/*
Copyright 2019 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/


/*
 * This module provides python-like logging capabilities using winston.
 */

import winston, { TransportInstance, LeveledLogMethod, LoggerInstance } from "winston";
import "winston-daily-rotate-file";
import { WriteStream } from "fs";


interface FormatterFnOpts {
    timestamp: () => string;
    level: string;
    meta: {[key: string]: string};
    message: string;
}

interface LoggerConfig {
    level: "debug"|"info"|"warn"|"error";
    logfile?: string; // path to file
    errfile?: string; // path to file
    toConsole: boolean;
    maxFiles: number;
    verbose: boolean;
}

const UNCAUGHT_EXCEPTION_ERRCODE = 101;

let loggerConfig: LoggerConfig = {
    level: "debug", //debug|info|warn|error
    logfile: undefined, // path to file
    errfile: undefined, // path to file
    toConsole: true, // make a console logger
    maxFiles: 5,
    verbose: false
};

const loggers: {[name: string]: LoggerInstance } = {
    // name_of_logger: Logger
};

let loggerTransports: TransportInstance[]; // from config

const makeTransports = function() {
    const timestampFn = function() {
        return new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
    };
    const formatterFn = function(opts: FormatterFnOpts) {
        return opts.timestamp() + ' ' +
        opts.level.toUpperCase() + ':' +
        (opts.meta && opts.meta.loggerName ? opts.meta.loggerName : "") + ' ' +
        (opts.meta && opts.meta.reqId ? ("[" + opts.meta.reqId + "] ") : "") +
        (opts.meta && opts.meta.dir ? opts.meta.dir : "") +
        (undefined !== opts.message ? opts.message : '');
    };

    let transports = [];
    if (loggerConfig.toConsole) {
        transports.push(new (winston.transports.Console)({
            json: false,
            name: "console",
            timestamp: timestampFn,
            formatter: formatterFn,
            level: loggerConfig.level
        }));
    }
    if (loggerConfig.logfile) {
        transports.push(new (winston.transports.DailyRotateFile)({
            filename: loggerConfig.logfile,
            json: false,
            name: "logfile",
            level: loggerConfig.level,
            timestamp: timestampFn,
            formatter: formatterFn,
            maxFiles: loggerConfig.maxFiles,
            datePattern: "YYYY-MM-DD",
            tailable: true
        }));
    }
    if (loggerConfig.errfile) {
        transports.push(new (winston.transports.DailyRotateFile)({
            filename: loggerConfig.errfile,
            json: false,
            name: "errorfile",
            level: "error",
            timestamp: timestampFn,
            formatter: formatterFn,
            maxFiles: loggerConfig.maxFiles,
            datePattern: "YYYY-MM-DD",
            tailable: true
        }));
    }
    // by default, EventEmitters will whine if you set more than 10 listeners on
    // them. The 'transport' is an emitter which the loggers listen for errors
    // from. Since we have > 10 files (each with their own logger), we get
    // warnings. Set the max listeners to unlimited to suppress the warning.
    transports.forEach(function(transport) {
        transport.setMaxListeners(0);
    });
    return transports;
};

const createLogger = function(nameOfLogger: string) {
    // lazily load the transports if one wasn't set from configure()
    if (!loggerTransports) {
        loggerTransports = makeTransports();
    }

    return new (winston.Logger)({
        transports: loggerTransports,
        // winston doesn't support getting the logger category from the
        // formatting function, which is a shame. Instead, write a rewriter
        // which sets the 'meta' info for the logged message with the loggerName
        rewriters: [
            function(level, msg, meta) {
                if (!meta) { meta = {}; }
                meta.loggerName = nameOfLogger;
                return meta;
            }
        ]
    });
};

/**
 * Obtain a logger by name, creating one if necessary.
 */
export function get(nameOfLogger: string) {
    if (loggers[nameOfLogger]) {
        return loggers[nameOfLogger];
    }
    let logger = createLogger(nameOfLogger);
    loggers[nameOfLogger] = logger;
    const ircLogger = {
        logErr: (e: Error) => {
            logger.error("Error: %s", JSON.stringify(e));
            if (e.stack) {
                logger.error(e.stack);
            }
        },
        ...logger,
    }
    return ircLogger;
}

export const getLogger = get;

/**
 * Configure how loggers should be created.
 */
export function configure(opts: LoggerConfig) {
    if (!opts) {
        return;
    }
    loggerConfig = opts;
    loggerTransports = makeTransports();
    // reconfigure any existing loggers. They may have been lazily loaded
    // with the default config, which is now being overwritten by this
    // configure() call.
    Object.keys(loggers).forEach(function(loggerName) {
        let existingLogger = loggers[loggerName];
        // remove each individual transport
        let transportNames = ["logfile", "console", "errorfile"];
        transportNames.forEach(function(tname) {
            if (existingLogger.transports[tname]) {
                existingLogger.remove(tname);
            }
        });
        // apply the new transports
        loggerTransports.forEach(function(transport) {
            existingLogger.add(transport, undefined, true);
        });
    });
}

export function isVerbose() {
    return loggerConfig.verbose;
}

export function newRequestLogger(baseLogger: LoggerInstance, requestId: string, isFromIrc: boolean) {
    const decorate = function(fn: LeveledLogMethod, args: IArguments ) {
        let newArgs: Array<any> = [];
        // don't slice this; screws v8 optimisations apparently
        for (let i = 0; i < args.length; i++) {
            newArgs.push(args[i]);
        }
        // add a piece of metadata to the log line, with the request ID.
        newArgs[args.length] = {
            reqId: requestId,
            dir: (isFromIrc ? "[I->M] " : "[M->I] ")
        };
        // Typescript doesn't like us mangling args like this, but we have to.
        // @ts-ignore
        fn.apply(baseLogger, newArgs);
    };
    return {
        debug: function() { decorate(baseLogger.debug, arguments); },
        info: function() { decorate(baseLogger.info, arguments); },
        warn: function() { decorate(baseLogger.warn, arguments); },
        error: function() { decorate(baseLogger.error, arguments); },
    };
}

export function setUncaughtExceptionLogger(exceptionLogger: LoggerInstance) {
    process.on("uncaughtException", function(e) {
        // Log to stderr first and foremost, to avoid any chance of us missing a flush.
        console.error("FATAL EXCEPTION");
        console.error(e && e.stack ? e.stack : String(e));

        // Log to winston handlers afterwards, if we can.
        exceptionLogger.error("FATAL EXCEPTION");
        if (e && e.stack) {
            exceptionLogger.error(e.stack);
        }
        else {
            exceptionLogger.error(e.name, e.message);
        }

        // We exit with UNCAUGHT_EXCEPTION_ERRCODE to ensure that the poor
        // developers debugging the bridge can identify where it exploded.

        // There have been issues where winston has failed to log the last
        // few lines before quitting, which I suspect is due to it not flushing.
        // Since we know we're going to die at this point, log something else
        // and forcibly flush all the transports before exiting.
        exceptionLogger.error("Terminating (exitcode=1)", function(err: Error) {
            let numFlushes = 0;
            let numFlushed = 0;
            Object.keys(exceptionLogger.transports).forEach(function(k) {
                // We need to access the unexposed _stream
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const stream: WriteStream = (exceptionLogger.transports[k] as any)._stream;
                if (stream) {
                    numFlushes += 1;
                    stream.once("finish", function() {
                        numFlushed += 1;
                        if (numFlushes === numFlushed) {
                            process.exit(UNCAUGHT_EXCEPTION_ERRCODE);
                        }
                    });
                    stream.on("error", function() {
                        // swallow
                    });
                    stream.end();
                }
            });
            if (numFlushes === 0) {
                process.exit(UNCAUGHT_EXCEPTION_ERRCODE);
            }
        });
    });
}
