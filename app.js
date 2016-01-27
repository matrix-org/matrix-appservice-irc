"use strict";
var Cli = require("matrix-appservice-bridge").Cli;
var main = require("./lib/main");

const REG_PATH = "appservice-registration-irc.yaml";

new Cli({
    registrationPath: REG_PATH,
    enableRegistration: true,
    enableLocalpart: true,
    bridgeConfig: {
        affectsRegistration: true,
        schema: "./lib/config/schema.yml",
        defaults: {
            ircService: {
                ident: {
                    enabled: false,
                    port: 113
                },
                logging: {
                    level: "debug",
                    toConsole: true
                },
                statsd: {}
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
            console.error("Failed to run bridge.");
            throw err;
        });
    }
}).run();
