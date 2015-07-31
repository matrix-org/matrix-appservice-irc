"use strict";
var q = require("q");

// The max length of <realname> in USER commands
var MAX_REAL_NAME_LENGTH = 48;
// The max length of <username> in USER commands
var MAX_USER_NAME_LENGTH = 10;

var getIdentUsername = function(domain, userId) {
    var uname = sanitiseUsername(userId.replace(/:/g, "__"));
    return uname;
};

var sanitiseUsername = function(username) {
    // strip illegal chars according to RFC 1459 Sect 2.3.1
    // (technically it's any <nonwhite> ascii for <user> but meh)
    return username.replace(/[^A-Za-z0-9\]\[\^\\\{\}\-`_]/g, "");
};

var sanitiseRealname = function(realname) {
    // real name can be any old ASCII
    return realname.replace(/[^\x00-\x7F]/g, "");
};

module.exports = {

    /**
     * Get the IRC name info for this user.
     * @param {IrcServer} server The IRC server being connected to.
     * @param {Object} ircUser The IRC user to connect as.
     * @param {Object} matrixUser Optional. The matrix user.
     * @return {Promise} Resolves to {
     *   nick: 'nick_to_use',
     *   username: 'username_to_use',
     *   realname: 'realname_to_use'
     * }
     */
    getIrcNames: function(ircUser, matrixUser) {
        var info = {};
        // strip illegal chars according to RFC 1459 Sect 2.3.1
        // but allow _ because most IRC servers allow that.
        info.nick = ircUser.nick.replace(/[^A-Za-z0-9\]\[\^\\\{\}\-`_]/g, "");
        if (matrixUser) {
            if (ircUser.username) {
                info.username = sanitiseUsername(ircUser.username);
            }
            else { // generate one.
                info.username = getIdentUsername(
                    ircUser.server.domain, matrixUser.userId
                );
            }
            info.realname = sanitiseRealname(matrixUser.userId);
        }
        else {
            info.username = sanitiseUsername(
                ircUser.username // the bridge won't have a mx user
            );
            info.realname = sanitiseRealname(info.username);
        }

        info.username = info.username.substring(0, MAX_USER_NAME_LENGTH);
        info.realname = info.realname.substring(0, MAX_REAL_NAME_LENGTH);

        return q(info);
    }
};
