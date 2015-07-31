"use strict";
var q = require("q");

// The max length of <realname> in USER commands
var MAX_REAL_NAME_LENGTH = 48;
// The max length of <username> in USER commands
var MAX_USER_NAME_LENGTH = 10;

/**
 * Generate a new IRC username for the given Matrix user on the given server.
 * @param {string} domain The IRC server domain
 * @param {string} userId The matrix user being bridged
 * @return {Promise} resolves to the username {string}.
 */
var generateIdentUsername = function(domain, userId) {
    // @foobar££stuff:domain.com  =>  foobar__stuff_domain_com
    var uname = sanitiseUsername(userId.substring(1), "_");
    if (uname < MAX_USER_NAME_LENGTH) { // bwahaha not likely.
        return uname;
    }
    uname = uname.substring(0, MAX_USER_NAME_LENGTH);
    /* LONGNAM~1 ing algorithm: (native tildes are replaced with _ above)
     * foobar => foob~1 => foob~2 => ... => foob~9 => foo~10 => foo~11 => ...
     * f~9999 => FAIL.
     *
     * Ideal data structure (Tries):
     * (each level from the root node increases digit count by 1)
     *    .---[f]---.            Translation:
     * 123[o]       [a]743       Up to fo~123 is taken
     *    |                      Up to fa~743 is taken
     * 34[o]                     Up to foo~34 is taken
     *    |                      Up to foot~9 is taken (re-search as can't increment)
     *  9[t]
     *
     * while not_free(uname):
     *   if ~ not in uname:
     *     uname = uname[0:-2] + "~1"    // foobar => foob~1
     *     continue
     *   num = uname.split(~)
     *   TODO
     *
     * return uname
     */

    return uname;
};

var sanitiseUsername = function(username, replacementChar) {
    replacementChar = replacementChar || "";
    // strip illegal chars according to RFC 1459 Sect 2.3.1
    // (technically it's any <nonwhite> ascii for <user> but meh)
    return username.replace(/[^A-Za-z0-9\]\[\^\\\{\}\-`_]/g, replacementChar);
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
            else {
                info.username = generateIdentUsername(
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
