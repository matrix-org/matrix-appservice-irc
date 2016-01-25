/*
 * Validates configuration yaml files and returns structured Config objects.
 * This works by reading in YAML, converting to JSON, then using JSON Schema
 * to validate the supplied config. If it all checks out, config objects are
 * created and returned.
 *
 * As we are just using JSON Schema for validation, there are no nice
 * descriptions supplied, since config.sample.yaml has that already.
 */
"use strict";

var extend = require("extend");
var fs = require("fs");
var yaml = require("js-yaml");
var JaySchema = require('jayschema');

var log = require("../logging").get("config-validator");
var SCHEMA_LOCATION = __dirname + "/schema.yml";

/**
 * Construct a new configuration validator.
 * @constructor
 * @param {Object|String} instOrFilename The path to the YAML file or a populated
 * config Object.
 * @throws If the file cannot be read.
 */
function Validator(instOrFilename) {
    this.config = instOrFilename;
    if (typeof instOrFilename === "string") {
        this.config = this.loadFromFile(instOrFilename);
    }
}
module.exports = Validator;
Validator.prototype.loadFromFile = function(filename) {
    return yaml.safeLoad(fs.readFileSync(filename, 'utf8'));
};

// static getter/setter for the config filename - we need this for hot reloading
var configFileLocation = "./config.yaml";
Validator.getFileLocation = function() {
    return configFileLocation;
};
Validator.setFileLocation = function(fileLoc) {
    configFileLocation = fileLoc;
};

/**
 * Validates the config object.
 * @return {?Object}
 */
Validator.prototype.validate = function() {
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
    var errors = js.validate(this.config, schema);
    if (errors.length > 0) {
        errors.forEach(function(error) {
            log.error(JSON.stringify(error));
            if (error.constraintName == "pattern") {
                log.error("The key %s has the value %s which fails to pass the " +
                    "regex check: %s", error.instanceContext, error.testedValue,
                    error.constraintValue);
            }
        });
        return null;
    }
    log.info("Valid config.yaml provided.");
    return createNewConfig(this.config);
};

function createNewConfig(cfg) {
    var inst = {};
    inst.appService = cfg.appService;
    inst.databaseUri = cfg.ircService.databaseUri;
    inst.statsd = cfg.ircService.statsd || {};

    var defaultIdent = {
        enabled: false,
        port: 113
    };
    inst.ident = extend(true, defaultIdent, cfg.ircService.ident);

    var defaultLogging = {
        level: "debug",
        toConsole: true
    };
    inst.logging = cfg.ircService.logging || defaultLogging;

    inst.servers = {};
    // assign defaults per server
    Object.keys(cfg.ircService.servers).forEach(function(serverName) {
        var server = cfg.ircService.servers[serverName];

        var defaultServerConfig = {
            botConfig: {
                nick: "appservicebot",
                joinChannelsIfNoUsers: true,
                enabled: true
            },
            privateMessages: {
                enabled: true,
                exclude: []
            },
            dynamicChannels: {
                enabled: false,
                published: true,
                createAlias: true,
                joinRule: "public",
                federate: true,
                aliasTemplate: "#irc_$SERVER_$CHANNEL",
                whitelist: [],
                exclude: []
            },
            mappings: {},
            matrixClients: {
                userTemplate: "@$SERVER_$NICK",
                displayName: "$NICK (IRC)"
            },
            ircClients: {
                nickTemplate: "M-$DISPLAY",
                maxClients: 30,
                idleTimeout: 172800,
                allowNickChanges: false
            },
            membershipLists: {
                enabled: false,
                global: {
                    ircToMatrix: {
                        initial: false,
                        incremental: false
                    },
                    matrixToIrc: {
                        initial: false,
                        incremental: false
                    }
                },
                channels: [],
                rooms: []
            }
        };
        if (server.dynamicChannels.visibility) {
            log.warn("--- Deprecation Warning ---");
            log.warn(
                "[DEPRECATED] Use of the config field dynamicChannels.visibility" +
                " is deprecated and will produce an error in a later release." +
                " Use dynamicChannels.published, dynamicChannels.joinRule and" +
                " dynamicChannels.createAlias instead."
            );
            if (server.dynamicChannels.visibility === "private") {
                server.dynamicChannels.published = false;
                server.dynamicChannels.createAlias = false;
                server.dynamicChannels.joinRule = "invite";
            }
            else if (server.dynamicChannels.visibility === "public") {
                server.dynamicChannels.published = true;
                server.dynamicChannels.createAlias = true;
                server.dynamicChannels.joinRule = "public";
            }
            else {
                throw new Error("Invalid 'visibility' config value.");
            }
        }
        // extend the default with the configured server. This sets the default
        // values shown above if the key is missing, else it leaves it alone and
        // uses the configured value.
        inst.servers[serverName] = extend(true, defaultServerConfig, server);
    });
    return inst;
}
