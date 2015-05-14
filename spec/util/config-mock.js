var validator = require("../../lib/config/validator");

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

module.exports.roomMapping = {
    server: "irc.example",
    botNick: "ro_bot_nick",
    channel: "#coffee",
    roomId: "!foo:bar"
};
var serverConfig = {
    "irc.example": {
        botConfig: {
            nick: module.exports.roomMapping.botNick
        },
        dynamicChannels: {
            enabled: true
        },
        mappings: {
            "#coffee": [module.exports.roomMapping.roomId]
        }
    }
};


var config = validator.loadConfig({
    appService: {
        homeserver: {
            url: module.exports.homeServerUrl,
            domain: module.exports.homeServerDomain
        },
        appservice: {
            token: module.exports.appServiceToken,
            url: module.exports.appServiceUrl
        },
        http: {
            port: module.exports.port
        },
        localpart: module.exports.botLocalpart
    },
    ircService: {
        databaseUri: module.exports.databaseUri,
        servers: serverConfig
    }
});
module.exports.ircConfig = config;
module.exports.serviceConfig = config.appService;
