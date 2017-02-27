"use strict";
var Cli = require("matrix-appservice-bridge").Cli;
var log = require("./lib/logging").get("CLI");
var main = require("./lib/main");
var path = require("path");
require("heapdump");

const REG_PATH = "appservice-registration-irc.yaml";

new Cli({
    registrationPath: REG_PATH,
    enableRegistration: true,
    enableLocalpart: true,
    bridgeConfig: {
        affectsRegistration: true,
        schema: path.join(__dirname, "lib/config/schema.yml"),
        defaults: {
            homeserver: {
                dropMatrixMessagesAfterSecs: 0,
            },
            ircService: {
                ident: {
                    enabled: false,
                    port: 113
                },
                logging: {
                    level: "debug",
                    toConsole: true
                },
                statsd: {},
                debugApi: {},
                provisioning: {
                    enabled: false,
                    requestTimeoutSeconds: 60 * 5
                }
            }
        }
    },
    generateRegistration: function(reg, callback) {
        main.generateRegistration(reg, this.getConfig()).done(function(completeRegistration) {
            callback(completeRegistration);
        });
    },
    run: function(port, config, reg) {
        main.runBridge(port, config, reg).catch(function(err) {
            log.error("Failed to run bridge.");
            throw err;
        });
    }
}).run();
