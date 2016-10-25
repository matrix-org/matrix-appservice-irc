"use strict";

const crypto = require('crypto');

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

        // The PEM string used to encrypt passwords when setPassword is
        // called and decrypt when getPassword is called.
        this._privateKey = null;

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

    setPrivateKey(privateKey) {
        if (this._privateKey) {
            throw new Error("Cannot override previously set privateKey!");
        }
        if (typeof privateKey !== 'string') {
            let actual = typeof privateKey;
            throw new Error("Private key must be an RSA PEM-formatted string, not " + actual);
        }
        this._privateKey = privateKey;
    }

    setPassword(password) {
        if (!this._privateKey) {
            this._config.password = password
            this._config.isPasswordEncrypted = false;
            return;
        }

        let encryptedPass = crypto.publicEncrypt(
            this._privateKey,
            new Buffer(password)
        );

        this._config.password = encryptedPass.toString('base64');
        this._config.isPasswordEncrypted = true;
    }

    getPassword() {
        if (!this._config.isPasswordEncrypted) {
            return this._config.password;
        }

        if (!this._privateKey) {
            throw new Error(`Cannot decrypt password of ${this.userId} - no private key given`);
        }
        console.info('Decrypting password with pkey' + this._privateKey.toString());
        return crypto.privateDecrypt(
            this._privateKey,
            new Buffer(this._config.password, 'base64')
        ).toString();
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
