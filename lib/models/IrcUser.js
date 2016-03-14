"use strict";
var RemoteUser = require("matrix-appservice-bridge").RemoteUser;

/**
 * Construct a new IRC user.
 * @constructor
 * @param {IrcServer} server : The IRC server the user is on.
 * @param {string} nick : The nick for this user.
 * @param {boolean} isVirtual : True if the user is not a real IRC user.
 * @param {string} password : The password to give to NickServ.
 * @param {string} username : The username of the client (for ident)
 */
class IrcUser extends RemoteUser {

    constructor(server, nick, isVirtual, password, username) {
        super(server.domain + "__@__" + nick, {
            domain: server.domain,
            nick: nick,
            isVirtual: Boolean(isVirtual),
            password: password || null,
            username: username || null
        });
        this.isVirtual = Boolean(isVirtual);
        this.server = server;
        this.nick = nick;
        this.password = password || null;
    }

    setConfig(config) {
        this.setUsername(config.getUsername());
        if (config.getDesiredNick()) {
            this.nick = config.getDesiredNick();
        }
    }

    setUsername(uname) {
        this.set("username", uname);
    }

    getUsername() {
        return this.get("username");
    }

    toString() {
        return this.nick + " (" + this.getUsername() + "@" +
            (this.server ? this.server.domain : "-") + ")";
    }
}

IrcUser.fromRemoteUser = function(server, remoteUser) {
    var ircUser = new IrcUser(
        server, remoteUser.get("nick"), remoteUser.get("isVirtual"),
        remoteUser.get("password"), remoteUser.get("username")
    );
    return ircUser;
};

module.exports = IrcUser;
