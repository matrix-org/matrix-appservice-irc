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

var makeTransports = function(nameOfLogger) {
    var timestampFn = function() {
        return new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
    };
    var formatterFn = function(opts) {
        return opts.timestamp()+' '+
        opts.level.toUpperCase()+':'+nameOfLogger+' '+
        (undefined !== opts.message ? opts.message : '') +
        (opts.meta && Object.keys(opts.meta).length ? '\n    '+ 
            JSON.stringify(opts.meta) : '' );
    };

    var transports = [];
    if (loggerConfig.toConsole) {
        transports.push(new (winston.transports.Console)({
            json: false,
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

var configureLogger = function(nameOfLogger) {
    var transports = makeTransports(nameOfLogger);
    return new (winston.Logger)({
        transports: transports
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
        var logger = configureLogger(nameOfLogger);
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
        // reconfigure any existing loggers
        Object.keys(loggers).forEach(function(loggerName) {
            var existingLogger = loggers[loggerName];
            var newTransports = makeTransports(loggerName);
            var transportNames = ["logfile", "console", "errorfile"];
            transportNames.forEach(function(tname) {
                if (existingLogger.transports[tname]) {
                    existingLogger.remove(tname);
                }
            });
            console.log("Repl %s", newTransports.length);
            newTransports.forEach(function(transport) {
                existingLogger.add(transport, undefined, true);
            });
        });
    }
};