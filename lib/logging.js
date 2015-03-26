/*
 * This module provides python-like logging capabilities using winston.
 */
"use strict";
var winston = require("winston");

var loggerConfig = {
    level: "debug", //debug|info|warn|error
    logfile: undefined, // path to file
    errfile: undefined, // path to file
    toConsole: true, // make a console logger
    maxFileSizeBytes: (1024 * 1024 * 128), // 128 MB
    maxFiles: 5
};

var loggers = {
    // name_of_logger: Logger
};
var loggerTransports = undefined; // from config

var generateRequestId = function() {
    return (Math.random()* 1e20).toString(36);
};

var makeTransports = function() {
    var timestampFn = function() {
        return new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
    };
    var formatterFn = function(opts) {
        return opts.timestamp()+' '+
        opts.level.toUpperCase()+':'+
        (opts.meta && opts.meta.loggerName ? opts.meta.loggerName : "")+' '+
        (opts.meta && opts.meta.reqId ? ("["+opts.meta.reqId+"] ") : "")+
        (undefined !== opts.message ? opts.message : '');
    };

    var transports = [];
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
        transports.push(new (winston.transports.File)({ 
            filename: loggerConfig.logfile,
            json: false,
            name: "logfile",
            level: loggerConfig.level,
            timestamp: timestampFn,
            formatter: formatterFn,
            maxsize: loggerConfig.maxFileSizeBytes,
            maxFiles: loggerConfig.maxFiles,
            tailable: true // most recent stuff always in filename.0.log
        }));
    }
    if (loggerConfig.errfile) {
        transports.push(new (winston.transports.File)({ 
            filename: loggerConfig.errfile,
            json: false,
            name: "errorfile",
            level: "error",
            handleExceptions: true,
            timestamp: timestampFn,
            formatter: formatterFn,
            maxsize: loggerConfig.maxFileSizeBytes,
            maxFiles: loggerConfig.maxFiles,
            tailable: true // most recent stuff always in filename.0.log
        }));
    }
    return transports;
};

var createLogger = function(nameOfLogger) {
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

module.exports = {
    /*
     * Obtain a logger by name, creating one if necessary.
     */
    get: function(nameOfLogger) {
        if (loggers[nameOfLogger]) {
            return loggers[nameOfLogger];
        }
        var logger = createLogger(nameOfLogger);
        loggers[nameOfLogger] = logger;
        return logger;
    },

    /*
     * Configure how loggers should be created.
     */
    configure: function(opts) {
        if (!opts) {
            return;
        }
        loggerConfig = opts;
        loggerTransports = makeTransports();
        // reconfigure any existing loggers. They may have been lazily loaded
        // with the default config, which is now being overwritten by this
        // configure() call.
        Object.keys(loggers).forEach(function(loggerName) {
            var existingLogger = loggers[loggerName];
            // remove each individual transport
            var transportNames = ["logfile", "console", "errorfile"];
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
    },

    newRequestLogger: function(baseLogger) {
        var requestId = generateRequestId();
        var decorate = function(fn, args) {
            var newArgs = [];
            // don't slice this; screws v8 optimisations apparently
            for (var i=0; i<args.length; i++) {
                newArgs.push(args[i]);
            }
            // add a piece of metadata to the log line, with the request ID.
            newArgs[args.length] = { reqId: requestId};
            fn.apply(this, newArgs);
        };

        return {
            debug: function() { decorate(baseLogger.debug, arguments); },
            info: function() { decorate(baseLogger.info, arguments); },
            warn: function() { decorate(baseLogger.warn, arguments); },
            error: function() { decorate(baseLogger.error, arguments); },
            log: function() { decorate(baseLogger.log, arguments); }
        };
    }
};