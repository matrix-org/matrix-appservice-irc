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
        if (!this.getDesiredNick()) {
            throw new Error("Client config must specify a nick");
        }
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

    setPassword(password) {
        this._config.password = password;
    }

    getPassword() {
        return this._config.password;
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

IrcClientConfig.newConfig = function(matrixUser, domain, nick, username, password) {
    return new IrcClientConfig(matrixUser ? matrixUser.getId() : null, domain, {
        nick: nick,
        username: username,
        password: password
    });
};

module.exports = IrcClientConfig;
