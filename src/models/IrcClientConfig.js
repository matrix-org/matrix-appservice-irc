"use strict";

/**
 * Contains IRC client configuration, mostly set by Matrix users. Used to configure
 * IrcUsers.
 */
class IrcClientConfig {

    /**
     * Construct an IRC Client Config.
     * @param {string} userId The user ID who is configuring this config.
     * @param {string} domain The IRC network domain for the IRC client
     * @param {Object} configObj Serialised config information if known.
     */
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

    setIpv6Address(address) {
        this._config.ipv6 = address;
    }

    getIpv6Address() {
        return this._config.ipv6;
    }

    serialize() {
        return this._config;
    }

    toString() {
        let redactedConfig = {
            username: this._config.username,
            nick: this._config.nick,
            ipv6: this._config.ipv6,
            password: this._config.password ? '<REDACTED>' : undefined,
        };
        return this.userId + "=>" + this.domain + "=" + JSON.stringify(redactedConfig);
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
