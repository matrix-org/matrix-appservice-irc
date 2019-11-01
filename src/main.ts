import Bluebird from "bluebird";
import Datastore from "nedb";
import extend from "extend";
import http from "http";
import https from "https";
import { RoomBridgeStore, UserBridgeStore } from "matrix-appservice-bridge";
import { IrcBridge } from "./bridge/IrcBridge";
import { IrcServer } from "./irc/IrcServer";
import stats from "./config/stats";
import ident from "./irc/Ident";
import * as logging from "./logging";
import { LoggerInstance } from "winston";
import { BridgeConfig } from "./config/BridgeConfig";
import { AppServiceRegistration } from "matrix-appservice";

const log = logging.get("main");

// We set this to 1000 by default now to set a default, and to ensure we're the first
// one to load the libraries in. Later on in runBridge we actually define the real limit.
http.globalAgent.maxSockets = 1000;
https.globalAgent.maxSockets = 1000;

process.on("unhandledRejection", (reason?: Error) => {
    log.error((reason ? reason.stack : undefined) || "No reason given");
});

const _toServer = (domain: string, serverConfig: any, homeserverDomain: string) => {
    // set server config defaults
    return new IrcServer(
        domain, extend(true, IrcServer.DEFAULT_CONFIG, serverConfig), homeserverDomain
    );
};

export async function generateRegistration(reg: AppServiceRegistration, config: BridgeConfig) {
    let asToken;


    if (!reg.getSenderLocalpart()) {
        reg.setSenderLocalpart(IrcBridge.DEFAULT_LOCALPART);
    }
    reg.setId(AppServiceRegistration.generateToken());
    reg.setHomeserverToken(AppServiceRegistration.generateToken());
    reg.setAppServiceToken(asToken || AppServiceRegistration.generateToken());

    // Disable rate limiting to allow large numbers of requests when many IRC users
    // connect, for example on startup.
    reg.setRateLimited(false);

    // Set protocols to IRC, so that the bridge appears in the list of
    // thirdparty protocols
    reg.setProtocols(["irc"]);

    const serverDomains = Object.keys(config.ircService.servers);
    serverDomains.sort().forEach(function(domain) {
        const server = _toServer(domain, config.ircService.servers[domain], config.homeserver.domain);
        server.getHardCodedRoomIds().sort().forEach(function(roomId) {
            reg.addRegexPattern("rooms", roomId, false);
        });
        // add an alias pattern for servers who want aliases exposed.
        if (server.createsDynamicAliases()) {
            reg.addRegexPattern("aliases", server.getAliasRegex(), true);
        }
        reg.addRegexPattern("users", server.getUserRegex(), true);
    });

    return reg;
}

export async function runBridge(port: number, config: BridgeConfig, reg: AppServiceRegistration, isDBInMemory = false) {
    // configure global stuff for the process
    if (config.ircService.logging) {
        logging.configure(config.ircService.logging);
        logging.setUncaughtExceptionLogger(log as LoggerInstance);
    }
    if (config.ircService.statsd.hostname) {
        log.warn("STATSD WILL BE DEPRECATED SOON")
        log.warn("SEE https://github.com/matrix-org/matrix-appservice-irc/issues/818")
        stats.setEndpoint(config.ircService.statsd);
    }
    if (config.ircService.ident && config.ircService.ident.enabled) {
        ident.configure(config.ircService.ident);
        ident.run();
    }

    const maxSockets = (config.advanced || {maxHttpSockets: 1000}).maxHttpSockets;
    require("http").globalAgent.maxSockets = maxSockets;
    require("https").globalAgent.maxSockets = maxSockets;

    // run the bridge
    const ircBridge = new IrcBridge(config, reg);
    const engine = config.database ? config.database.engine : "nedb";
    // Use in-memory DBs
    if (isDBInMemory) {
        ircBridge.getAppServiceBridge().opts.roomStore = new RoomBridgeStore(new Datastore());
        ircBridge.getAppServiceBridge().opts.userStore = new UserBridgeStore(new Datastore());
    }
    else if (engine === "postgres") {
        // Enforce these not to be created
        ircBridge.getAppServiceBridge().opts.roomStore = undefined;
        ircBridge.getAppServiceBridge().opts.userStore = undefined;
    }
    else if (engine !== "nedb") {
        // do nothing.
    }
    else {
        throw Error("Invalid database configuration");
    }

    await ircBridge.run(port);
    return ircBridge;
}

export function killBridge(ircBridge: IrcBridge) {
    if (!ircBridge) {
        log.info('killBridge(): No bridge running');
        return Bluebird.resolve();
    }
    log.info('Killing bridge');
    return ircBridge.kill();
}
