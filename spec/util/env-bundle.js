const test = require("../util/test");

module.exports = function() {
    // set up integration testing mocks
    const env = test.mkEnv();

    // set up test config
    const config = env.config;
    const roomMapping = {
        server: config._server,
        botNick: config._botnick,
        channel: config._chan,
        roomId: config._roomid
    };
    const botUserId = config._botUserId;

    return {env, config, roomMapping, botUserId, test};
};
