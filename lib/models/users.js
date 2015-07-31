/*
 * The purpose of this file is to provide a way of representing users and
 * convert between them.
 *
 * A user ID represents a Matrix user uniquely.
 * An IRC nick and server domain represent an IRC user uniquely.
 * Some user IDs are special and should NOT be relayed (virtual users)
 * Some IRC nicks are special and should NOT be relayed (stored IRC mapping)
 */
"use strict";

/**
 * Construct a new Matrix user.
 * @constructor
 * @param {string} userId : The user ID representing this user.
 * @param {string} displayName : The display name for this user.
 * @param {boolean} isVirtual : True if this is not a real Matrix user.
 */
function MatrixUser(userId, displayName, isVirtual) {
    this.isVirtual = isVirtual;
    this.protocol = "matrix";
    this.userId = userId;
    this.displayName = displayName;
}

/**
 * Construct a new IRC user.
 * @constructor
 * @param {IrcServer} server : The IRC server the user is on.
 * @param {string} nick : The nick for this user.
 * @param {boolean} isVirtual : True if the user is not a real IRC user.
 * @param {string} password : The password to give to NickServ.
 */
function IrcUser(server, nick, isVirtual, password) {
    this.protocol = "irc";
    this.isVirtual = isVirtual;
    this.server = server;
    this.nick = nick;
    this.password = password;
    this.username = null;
}


module.exports.IrcUser = IrcUser;
module.exports.MatrixUser = MatrixUser;
