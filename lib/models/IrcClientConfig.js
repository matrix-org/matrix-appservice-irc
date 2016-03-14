"use strict";

/**
 * Contains IRC client configuration, mostly set by Matrix users. Used to configure
 * IrcUsers.
 */
class IrcClientConfig {
    constructor(userId, domain, configObj) {
        this.userId = userId;
        this.domain = domain;
        this._config = configObj || {};
    }

    getDomain() {
        return this.domain;
    }

    getUserId() {
        return this.userId;
    }

    setUsername(uname) {
        this._config.username = uname;
    }

    getUsername() {
        return this._config.username;
    }

    setDesiredNick(nick) {
        this._config.nick = nick;
    }

    getDesiredNick() {
        return this._config.nick;
    }

    serialize() {
        return this._config;
    }

    toString() {
        return this.userId + "=>" + this.domain + "=" + JSON.stringify(this._config);
    }
}

IrcClientConfig.newConfig = function(matrixUser, ircUser) {
    let config = new IrcClientConfig(matrixUser.getId(), ircUser.server.domain);
    config.setUsername(ircUser.getUsername());
    config.setDesiredNick(ircUser.nick);
    return config;
};

module.exports = IrcClientConfig;
