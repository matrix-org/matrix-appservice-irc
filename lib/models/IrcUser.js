"use strict";

/**
 * Construct a new IRC user.
 * @constructor
 * @param {IrcServer} server : The IRC server the user is on.
 * @param {string} nick : The nick for this user.
 * @param {boolean} isVirtual : True if the user is not a real IRC user.
 * @param {string} password : The password to give to NickServ.
 * @param {string} username : The username of the client (for ident)
 */
function IrcUser(server, nick, isVirtual, password, username) {
    this.protocol = "irc";
    this.isVirtual = Boolean(isVirtual);
    this.server = server;
    this.nick = nick;
    this.password = password || null;
    this.username = username || null;
}
IrcUser.prototype.toString = function() {
    return this.nick + " (" + this.username + "@" +
        (this.server ? this.server.domain : "-") + ")";
};

module.exports = IrcUser;
