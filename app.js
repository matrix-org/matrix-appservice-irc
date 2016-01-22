"use strict";
var crc = require("crc");
var crypto = require("crypto");
var yaml = require("js-yaml");
var fs = require("fs");
var nopt = require("nopt");

var Validator = require("./lib/config/validator");

// when invoked with 'node app.js', make an AS with just the IRC service.
var appservice = require("matrix-appservice");
var irc = require("./lib/irc-appservice.js");

var opts = nopt({
    "generate-registration": Boolean,
    "skip-crc-check": Boolean,
    "config": String,
    "verbose": Boolean,
    "help": Boolean
}, {
    "c": "--config",
    "v": "--verbose",
    "s": "--skip-crc-check",
    "h": "--help"
});

if (opts.help) {
    var help = {
        "--config -c": (
            "Specify a config file to load. Will look for '"+
            Validator.getFileLocation()+"' if omitted."
        ),
        "--verbose -v": "Turn on verbose logging. This will log all incoming IRC events.",
        "--generate-registration": "Create the registration YAML for this application service.",
        "--skip-crc-check -s": (
            "Start the application service even if it detects a mismatched home server"+
            "\n      token. Only use this if you know what you're doing (e.g. a change"+
            "\n      to the config file which you know is safe to make without updating"+
            "\n      the application service registration)."
        ),
        "--help -h": "Display this help message."
    };
    console.log("Node.js IRC Application Service");
    console.log("\nOptions:")
    Object.keys(help).forEach(function(cmd) {
        console.log("  %s", cmd);
        console.log("      %s", help[cmd]);
    });
    console.log();
    process.exit(0);
}
if (opts.config) {
    Validator.setFileLocation(opts.config);
}

// load the config file
var config;
try {
    var configValidator = new Validator(Validator.getFileLocation());
    config = configValidator.validate();
}
catch (e) {
    console.error(e);
    process.exit(1);
    return;
}

if (!config) {
    console.error("Failed to validate config file.");
    process.exit(1);
    return;
}
config.appService.service = irc;
config.appService.generateRegistration = Boolean(opts["generate-registration"]);
config.appService.skipCrcCheck = Boolean(opts["skip-crc-check"]);
config.logging.verbose = Boolean(opts["verbose"]);

// make a checksum of the IRC server configuration. This will be checked against
// the checksum created at the last "--generate-registration". If there is a
// difference, it means that the user has failed to tell the HS of the new
// registration, so we can refuse to start until that is done.
var checksum = crc.crc32(JSON.stringify(config.servers)).toString(16);
var randomPart = crypto.randomBytes(32).toString('hex');
config.appService.homeserver.token = randomPart + "_crc" + checksum;
irc.configure(config);
appservice.registerService(config.appService);

if (config.appService.generateRegistration) {
    var fname = "appservice-registration-irc.yaml";
    console.log("Generating registration file to %s...", fname);
    appservice.getRegistration().done(function(registration) {
        fs.writeFile(fname, yaml.safeDump(registration), function(e) {
            if (e) {
                console.error("Failed to write registration file: %s", e);
                return;
            }
            console.log(" "+Array(74).join("="));
            console.log("   Generated registration file located at:");
            console.log("       %s", fname);
            console.log("");
            console.log("   The HS token this service looks for has been"+
                " updated. You MUST update");
            console.log("   the HS even if config.yaml was not modified."+
                " This file MUST be added");
            console.log("   to the destination home "+
                "server configuration file (e.g. 'homeserver.yaml'):");
            console.log("");
            console.log('       app_service_config_files: '+
                '["appservice-registration-irc.yaml"]');
            console.log(" "+Array(74).join("="));
            process.exit(0);
        });
    });
}
else {
    hotReload.setup();
    appservice.runForever();
}
