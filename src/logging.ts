/*
 * This module provides python-like logging capabilities using winston.
 */
import {LoggerInstance, TransportInstance, transports as WinstonTransports, Winston, LeveledLogMethod} from "winston";
import * as winston from "winston";
import "winston-daily-rotate-file";

export interface ILogger {
    debug: LeveledLogMethod,
    info: LeveledLogMethod,
    warn: LeveledLogMethod,
    error: LeveledLogMethod,
    log: LeveledLogMethod,
}

export interface ILoggerLogErr extends LoggerInstance {
    logErr: (err: Error) => void,
}

export default class StaticLogger {

    private static loggerConfig = {
        level: "debug",
        logfile: undefined,
        errfile: undefined,
        toConsole: true,
        maxFiles: 5,
        verbose: false
    };

    private static loggers: {
        [name: string]: LoggerInstance
    } = {};

    private static loggerTransports: TransportInstance[]; // from config

    private static timestampFn () {
        return new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
    }

    private static formatterFn (opts: any) {
        return opts.timestamp() + ' ' +
            opts.level.toUpperCase() + ':' +
            (opts.meta && opts.meta.loggerName ? opts.meta.loggerName : "") + ' ' +
            (opts.meta && opts.meta.reqId ? ("[" + opts.meta.reqId + "] ") : "") +
            (opts.meta && opts.meta.dir ? opts.meta.dir : "") +
            (undefined !== opts.message ? opts.message : '');
    }

    private static makeTransports () {
        const transports = [];
        if (StaticLogger.loggerConfig.toConsole) {
            transports.push(new (WinstonTransports.Console)({
                json: false,
                name: "console",
                timestamp: StaticLogger.timestampFn,
                formatter: StaticLogger.formatterFn,
                level: StaticLogger.loggerConfig.level
            }));
        }
        if (StaticLogger.loggerConfig.logfile) {
            transports.push(new (WinstonTransports.DailyRotateFile)({
                filename: StaticLogger.loggerConfig.logfile,
                json: false,
                name: "logfile",
                level: StaticLogger.loggerConfig.level,
                timestamp: StaticLogger.timestampFn,
                formatter: StaticLogger.formatterFn,
                maxFiles: StaticLogger.loggerConfig.maxFiles,
                datePattern: "YYYY-MM-DD",
                tailable: true
            }));
        }
        if (StaticLogger.loggerConfig.errfile) {
            transports.push(new (WinstonTransports.DailyRotateFile)({
                filename: StaticLogger.loggerConfig.errfile,
                json: false,
                name: "errorfile",
                level: "error",
                timestamp: StaticLogger.timestampFn,
                formatter: StaticLogger.formatterFn,
                maxFiles: StaticLogger.loggerConfig.maxFiles,
                datePattern: "YYYY-MM-DD",
                tailable: true
            }));
        }
        // by default, EventEmitters will whine if you set more than 10 listeners on
        // them. The 'transport' is an emitter which the loggers listen for errors
        // from. Since we have > 10 files (each with their own logger), we get
        // warnings. Set the max listeners to unlimited to suppress the warning.
        transports.forEach(function (transport) {
            transport.setMaxListeners(0);
        });
        return transports;
    }

    private static createLogger(nameOfLogger: string): LoggerInstance {
        // lazily load the transports if one wasn't set from configure()
        if (!StaticLogger.loggerTransports) {
            StaticLogger.loggerTransports = StaticLogger.makeTransports();
        }
        return new (winston.Logger)({
            transports: StaticLogger.loggerTransports,
            // winston doesn't support getting the longestUncaughtExceptionLogger category from the
            // formatting function, which is a shame. Instead, write a rewriter
            // which sets the 'meta' info for the logged message with the loggerName
            rewriters: [
                (level, msg, meta) => {
                    if (!meta) {
                        meta = {};
                    }
                    meta.loggerName = nameOfLogger;
                    return meta;
                }
            ]
        });
    }

    /*
     * Obtain a logger by name, creating one if necessary.
     */
    public static get(nameOfLogger: string): ILoggerLogErr {
        if (StaticLogger.loggers[nameOfLogger]) {
            // logErr is defined
            return StaticLogger.loggers[nameOfLogger] as any as ILoggerLogErr;
        }
        const baseLogger: any = StaticLogger.createLogger(nameOfLogger);
        baseLogger.logErr = (e: Error) => {
            baseLogger.error("Error: %s", JSON.stringify(e));
            if (e.stack) {
                baseLogger.error(e.stack);
            }
        };
        StaticLogger.loggers[nameOfLogger] = baseLogger;
        return baseLogger;
    }

    /*
     * Configure how loggers should be created.
     */
    public static configure (opts: any) {
        if (!opts) {
            return;
        }
        StaticLogger.loggerConfig = opts;
        StaticLogger.loggerTransports = StaticLogger.makeTransports();
        // reconfigure any existing loggers. They may have been lazily loaded
        // with the default config, which is now being overwritten by this
        // configure() call.
        Object.keys(StaticLogger.loggers).forEach((loggerName) => {
            const existingLogger = StaticLogger.loggers[loggerName];
            // remove each individual transport
            const transportNames = ["logfile", "console", "errorfile"];
            transportNames.forEach((tname) => {
                if (existingLogger.transports[tname]) {
                    existingLogger.remove(tname);
                }
            });
            // apply the new transports
            StaticLogger.loggerTransports.forEach((transport) => {
                existingLogger.add(transport, undefined, true);
            });
        });
    }

    public static isVerbose (): boolean {
        return StaticLogger.loggerConfig.verbose;
    }

    public static newRequestLogger (baseLogger: LoggerInstance, requestId: string, isFromIrc: boolean): ILogger {
        const decorate = (fn: (...args: any[]) => void, args: any) => {
            const newArgs = [];
            // don't slice this; screws v8 optimisations apparently
            for (let i = 0; i < args.length; i++) {
                newArgs.push(args[i]);
            }

            // add a piece of metadata to the log line, with the request ID.
            newArgs[args.length] = {
                reqId: requestId,
                dir: (isFromIrc ? "[I->M] " : "[M->I] ")
            };

            fn.apply(baseLogger, newArgs);
        };

        return {
            debug: function () { decorate(baseLogger.debug, arguments); return baseLogger; },
            info: function () { decorate(baseLogger.info, arguments);  return baseLogger; },
            warn: function () { decorate(baseLogger.warn, arguments);  return baseLogger; },
            error: function () { decorate(baseLogger.error, arguments);  return baseLogger; },
            log: function () { decorate(baseLogger.log, arguments);  return baseLogger; }
        };
    }

    public static setUncaughtExceptionLogger(exceptionLogger: LoggerInstance) {
        process.on("uncaughtException", function (e) {
            exceptionLogger.error("FATAL EXCEPTION");
            if (e && e.stack) {
                exceptionLogger.error(e.stack);
            }
            else {
                exceptionLogger.error(e as any);
            }
            // There have been issues where winston has failed to log the last
            // few lines before quitting, which I suspect is due to it not flushing.
            // Since we know we're going to die at this point, log something else
            // and forcibly flush all the transports before exiting.
            exceptionLogger.error("Terminating (exitcode=1)", function () {
                let numFlushes = 0;
                let numFlushed = 0;
                exceptionLogger.transports
                Object.keys(exceptionLogger.transports).forEach(function (k) {
                    const transport = exceptionLogger.transports[k] as any;
                    if (transport._stream) {
                        numFlushes += 1;
                        transport._stream.once("finish", function () {
                            numFlushed += 1;
                            if (numFlushes === numFlushed) {
                                process.exit(1);
                            }
                        });
                        transport._stream.on("error", function () {
                            // swallow
                        });
                        transport._stream.end();
                    }
                });
                if (numFlushes === 0) {
                    process.exit(1);
                }
            });
        });
    }
}

export const get = StaticLogger.get;
export const configure = StaticLogger.configure;
export const isVerbose = StaticLogger.isVerbose;
export const newRequestLogger = StaticLogger.newRequestLogger;
export const setUncaughtExceptionLogger = StaticLogger.setUncaughtExceptionLogger;