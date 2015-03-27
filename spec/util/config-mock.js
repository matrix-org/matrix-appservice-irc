
module.exports = {
    databaseUri: "mongodb://localhost:27017/matrix-appservice-irc-integration",
    ircServer: "irc.example",
    botNick: "a_nick",
    channel: "#coffee",
    roomId: "!foo:bar",
    roomMapping: {},
    homeServerUrl: "https://some.home.server.goeshere",
    homeServerDomain: "some.home.server",
    appServiceToken: "it's a secret",
    appServiceUrl: "https://mywuvelyappservicerunninganircbridgeyay.gome",
    port: 2
};
module.exports.roomMapping[module.exports.channel] = [module.exports.roomId];


module.exports.ircConfig = {
    databaseUri: module.exports.databaseUri,
    servers: {}
};
module.exports.ircConfig.servers[module.exports.ircServer] = {
    nick: module.exports.botNick,
    expose: {
        channels: true,
        privateMessages: true
    },
    rooms: {
        mappings: module.exports.roomMapping
    }
}

module.exports.serviceConfig = {
    hs: module.exports.homeServerUrl,
    hsDomain: module.exports.homeServerDomain,
    token: module.exports.appServiceToken,
    as: module.exports.appServiceUrl,
    port: module.exports.port
};