var extend = require("extend");
var main = require("../../lib/main");

/**
 * Default test AS information
 */
module.exports = {
    databaseUri: "nedb://spec-db",
    homeServerUrl: "https://some.home.server.goeshere",
    homeServerDomain: "some.home.server",
    homeServerToken: "foobar",
    botLocalpart: "monkeybot",
    appServiceToken: "it's a secret",
    appServiceUrl: "https://mywuvelyappservicerunninganircbridgeyay.gome",
    port: 2
};

/**
 * Default test room mapping.
 */
module.exports.roomMapping = {
    server: "irc.example",
    botNick: "ro_bot_nick",
    channel: "#coffee",
    roomId: "!foo:bar"
};
var serverConfig = {
    "irc.example": extend(true, main.defaultServerConfig(), {
        botConfig: {
            nick: module.exports.roomMapping.botNick,
            joinChannelsIfNoUsers: true
        },
        dynamicChannels: {
            enabled: true
        },
        mappings: {
            "#coffee": [module.exports.roomMapping.roomId]
        }
    })
};

var config = main.defaultConfig();
config.homeserver = {
    url: module.exports.homeServerUrl,
    domain: module.exports.homeServerDomain
};
config.ircService.databaseUri = module.exports.databaseUri;
config.ircService.servers = serverConfig;

/**
 * Default test IRC config.
 */
module.exports.ircConfig = config.ircService;
/**
 * Default test AS config.
 */
module.exports.serviceConfig = {
    homeserver: {
        url: module.exports.homeServerUrl,
        domain: module.exports.homeServerDomain
    },
    appservice: {
        token: module.exports.appServiceToken,
        url: module.exports.appServiceUrl
    },
    localpart: module.exports.botLocalpart
};
module.exports.appServiceRegistration = {
    hs_token: module.exports.homeServerToken,
    as_token: module.exports.appServiceToken,
    url: module.exports.appServiceUrl,
    sender_localpart: module.exports.botLocalpart
};
module.exports.config = config;
