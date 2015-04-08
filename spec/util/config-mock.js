
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

// a default room mapping from the config.
var roomMapping = {
    server: "irc.example",
    botNick: "a_nick",
    channel: "#coffee",
    roomId: "!foo:bar"
};
module.exports.roomMapping = roomMapping; 


// construct the irc config from the roomMapping
module.exports.ircConfig = {
    databaseUri: module.exports.databaseUri,
    servers: {}
};
module.exports.ircConfig.servers[roomMapping.server] = {
    nick: roomMapping.botNick,
    expose: {
        channels: true,
        privateMessages: true
    },
    rooms: {
        mappings: {}
    }
};
module.exports.ircConfig.servers[roomMapping.server].rooms.mappings[
    roomMapping.channel
] = roomMapping.roomId;


module.exports.serviceConfig = {
    hs: module.exports.homeServerUrl,
    hsDomain: module.exports.homeServerDomain,
    hsToken: module.exports.homeServerToken,
    token: module.exports.appServiceToken,
    localpart: module.exports.botLocalpart,
    as: module.exports.appServiceUrl,
    port: module.exports.port
};