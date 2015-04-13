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
    botNick: "a_nick",
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
        hs: module.exports.homeServerUrl,
        hsDomain: module.exports.homeServerDomain,
        token: module.exports.appServiceToken,
        as: module.exports.appServiceUrl,
        port: module.exports.port,
        localpart: module.exports.botLocalpart
    },
    ircService: {
        databaseUri: module.exports.databaseUri,
        servers: serverConfig
    }
});
module.exports.ircConfig = config;
module.exports.serviceConfig = config.appService;