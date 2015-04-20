/*
 * Validates configuration yaml files and returns structured Config objects.
 * This works by reading in YAML, converting to JSON, then using JSON Schema
 * to validate the supplied config. If it all checks out, config objects are
 * created and returned.
 *
 * As we are just using JSON Schema for validation, there are no nice descriptions
 * supplied, since config.sample.yaml has that already.
 */
"use strict";
var extend = require("extend");
var fs = require("fs");
var yaml = require("js-yaml");
var JaySchema = require('jayschema');

var log = require("../logging").get("config-validator");

var SCHEMA_LOCATION = __dirname + "/schema.yml";

module.exports.loadConfig = function(inst) {
    var js = new JaySchema();
    var schema;
    try {
        schema = yaml.safeLoad(fs.readFileSync(SCHEMA_LOCATION, "utf8"));
    } 
    catch (e) {
        log.error("Failed to read schema file");
        log.error(JSON.stringify(e));
        return null;
    }
    var errors = js.validate(inst, schema);
    if (errors.length > 0) {
        errors.forEach(function(error) {
            log.error(JSON.stringify(error));
            if (error.constraintName == "pattern") {
                log.error("The key %s has the value %s which fails to pass the "+
                    "regex check: %s", error.instanceContext, error.testedValue,
                    error.constraintValue);
            }
        });
        return null;
    }
    log.info("Valid config.yaml provided.");
    return new Config(inst);
};

function Config(cfg) {
    this.appService = cfg.appService;
    this.databaseUri = cfg.ircService.databaseUri;
    this.statsd = cfg.ircService.statsd || {};

    var defaultLogging = {
        level: "debug",
        toConsole: true
    };
    this.logging = cfg.ircService.logging || defaultLogging;

    this.servers = {};
    var self = this;
    // assign defaults per server
    Object.keys(cfg.ircService.servers).forEach(function(serverName) {
        var server = cfg.ircService.servers[serverName];

        var defaultServerConfig = {
            botConfig: {
                nick: "appservicebot"
            },
            privateMessages: {
                enabled: true,
                exclude: []
            },
            dynamicChannels: {
                enabled: false,
                visibility: "public",
                federate: true,
                aliasTemplate: "#irc_$SERVER_$CHANNEL",
                whitelist: [],
                exclude: []
            },
            mappings:{},
            matrixClients: {
                userTemplate: "@$SERVER_$NICK",
                displayName: "$NICK (IRC)"
            },
            ircClients: {
                nickTemplate: "M-$DISPLAY",
                maxClients: 30,
                allowNickChanges: false
            }
        };
        // extend the default with the configured server. This sets the default
        // values shown above if the key is missing, else it leaves it alone and
        // uses the configured value.
        self.servers[serverName] = extend(true, defaultServerConfig, server);
    });
}