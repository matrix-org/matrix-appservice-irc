"use strict";
const Cli = require("matrix-appservice-bridge").Cli;
const log = require("./lib/logging").get("CLI");
const {logErr} = require("./lib/logging");
const main = require("./lib/main");
const path = require("path");

const REG_PATH = "appservice-registration-irc.yaml";
let bridge;
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
                debugApi: {},
                provisioning: {
                    enabled: false,
                    requestTimeoutSeconds: 60 * 5
                },
                permissions: {},
            }
        },
    },
    onConfigChanged: function(config) {
        bridge.onConfigChanged(config);
    },
    generateRegistration: function(reg, callback) {
        try {
            const completeReg = main.generateRegistration(reg, this.getConfig());
            callback(completeReg);
        }
        catch (ex) {
            log.error("Failed to generate registration:", ex);
            process.exit(1);
        }
    },
    run: function(port, config, reg) {
        if (port === -1) {
            port = null;
        }
        main.runBridge(port, config, reg).then((resultBridge) => {
            bridge = resultBridge;
        }).catch(function(err) {
            log.error("Failed to run bridge.");
            logErr(log, err);
            process.exit(1);
        });

        process.on("SIGTERM", async () => {
            log.info("SIGTERM recieved, killing bridge");
            try {
                await main.killBridge(bridge, "Bridge terminating on SIGTERM");
            }
            catch (ex) {
                log.error("Failed to killBridge");
                log.error(ex);
                process.exit(1);
            }
            process.exit(0);
        });
    }
}).run();
