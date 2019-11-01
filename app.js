"use strict";
const Cli = require("matrix-appservice-bridge").Cli;
const log = require("./lib/logging").get("CLI");
const main = require("./lib/main");
const path = require("path");

const REG_PATH = "appservice-registration-irc.yaml";
new Cli({
    registrationPath: REG_PATH,
    enableRegistration: true,
    enableLocalpart: true,
    port: -1, // Set this here so we know if the port is a default
    bridgeConfig: {
        affectsRegistration: true,
        schema: path.join(__dirname, "config.schema.yml"),
        defaults: {
            homeserver: {
                dropMatrixMessagesAfterSecs: 0,
                enablePresence: true
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
        if (port === -1) {
            port = null;
        }
        main.runBridge(port, config, reg).catch(function(err) {
            log.error("Failed to run bridge.");
            throw err;
        });
    }
}).run();
