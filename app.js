"use strict";
var crc = require("crc");
var crypto = require("crypto");
var yaml = require("js-yaml");
var fs = require("fs");

var validator = require("./lib/config/validator");

// when invoked with 'node app.js', make an AS with just the IRC service.
var appservice = require("matrix-appservice");
var irc = require("./lib/irc-appservice.js");

var configFile = undefined;
var generateRegistration = process.argv[2] == "--generate-registration";

// load the config file
try {
    configFile = yaml.safeLoad(fs.readFileSync('./config.yaml', 'utf8'));
} 
catch (e) {
    console.error(e);
    return;
}

var config = validator.loadConfig(configFile);
if (!config) {
    console.error("Failed to validate config file.");
    process.exit(1);
    return;
}
config.appService.service = irc;
config.appService.generateRegistration = generateRegistration;


var checksum = crc.crc32(JSON.stringify(configFile)).toString(16);
irc.configure(config);
// assign the HS token now: this involves CRCing the config.yaml to avoid
// people changing that file but not updating the home server config.
var randomPart = crypto.randomBytes(32).toString('hex');
config.appService.hsToken = randomPart + "_crc" + checksum;

appservice.registerServices([config.appService]);

if (generateRegistration) {
    var fname = "appservice-registration-irc.yaml";
    console.log("Generating registration file to %s...", fname);
    appservice.getRegistrations().done(function(entries) {
        var registration = entries[0];
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
    appservice.runForever();
}
