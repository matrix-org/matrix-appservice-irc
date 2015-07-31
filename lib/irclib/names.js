"use strict";
var q = require("q");

// The max length of <realname> in USER commands
var MAX_REAL_NAME_LENGTH = 48;
// The max length of <username> in USER commands
var MAX_USER_NAME_LENGTH = 32;

module.exports = {
    /**
     * Get the IRC name info for this user.
     * @param {IrcServer} server The IRC server being connected to.
     * @param {string} nick The desired nick to connect with.
     * @param {Object} matrixUser Optional. The matrix user.
     * @return {Promise} Resolves to {
     *   nick: 'nick_to_use',
     *   username: 'username_to_use',
     *   realname: 'realname_to_use'
     * }
     */
    getIrcNames: function(server, nick, matrixUser) {
        var info = {};
        // strip illegal chars according to RFC 1459 Sect 2.3.1
        // but allow _ because most IRC servers allow that.
        info.nick = nick.replace(/[^A-Za-z0-9\]\[\^\\\{\}\-`_]/g, "");
        var username = matrixUser ? matrixUser.userId : "matrixirc";
        // real name can be any old ASCII
        var realname = username.replace(/[^\x00-\x7F]/g, "");
        // strip out bad characters in the username (will need to do something
        // better like punycode with win95 style LONGNAM~1 in the future)
        username = username.replace(/:/g, "__");
        username = username.replace(/[^A-Za-z0-9\]\[\^\\\{\}\-`_]/g, "");

        info.username = username.substring(0, MAX_USER_NAME_LENGTH);
        info.realname = realname.substring(0, MAX_REAL_NAME_LENGTH);
        return q(info);
    }
};
