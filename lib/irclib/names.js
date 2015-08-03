"use strict";
var q = require("q");
var store = require("../store");
var log = require("../logging").get("irc-names");

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
    log.debug("Generating ident username for %s on %s", userId, domain);
    // @foobar££stuff:domain.com  =>  foobar__stuff_domain_com
    var d = q.defer();
    var uname = sanitiseUsername(userId.substring(1));
    if (uname < MAX_USER_NAME_LENGTH) { // bwahaha not likely.
        return uname;
    }
    uname = uname.substring(0, MAX_USER_NAME_LENGTH);
    /* LONGNAM~1 ing algorithm: (native tildes are replaced with _ above)
     * foobar => foob~1 => foob~2 => ... => foob~9 => foo~10 => foo~11 => ...
     * f~9999 => FAIL.
     *
     * Ideal data structure (Tries): TODO
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
     *     uname = uname[0:-2] + "~1"               // foobar => foob~1
     *     continue
     *   [name, num] = uname.split(~)               // foob~9 => ['foob', '9']
     *   old_digits_len = len(str(num))             // '9' => 1
     *   num += 1
     *   new_digits_len = len(str(num))             // '10' => 2
     *   if new_digits_len > old_digits_len:
     *     uname = name[:-1] + "~" + num            // foob,10 => foo~10
     *   else:
     *     uname = name + "~" + num                 // foob,8 => foob~8
     *
     * return uname
     */
    var delim = "_";
    function modifyUsername() {
        if (uname.indexOf(delim) === -1) {
            uname = uname.substring(0, uname.length - 2) + delim + "1";
            return true;
        }
        var segments = uname.split(delim);
        var oldLen = segments[1].length;
        var num = parseInt(segments[1]) + 1;
        if (("" + num).length > oldLen) {
            uname = segments[0].substring(0, segments[0].length - 1) + delim + num;
        }
        else {
            uname = segments[0] + delim + num;
        }
        return uname.indexOf(delim) !== 0; // break out if '~10000'
    }

    function loop() {
        store.ircClients.getByUsername(domain, uname).done(function(usr) {
            if (usr && usr.userId !== userId) { // occupied username!
                var shouldContinue = modifyUsername();
                if (shouldContinue) {
                    loop();
                }
                else {
                    d.reject("Ran out of entries: " + uname);
                }
            }
            else {
                log.info(
                    "Generated ident username %s for %s on %s",
                    uname, userId, domain
                );
                d.resolve(uname);
            }
        }, function(e) {
            log.error("Failed to check username %s for %s : %e", uname, userId, e);
        });
    }

    loop();

    return d.promise;
};

var sanitiseUsername = function(username, replacementChar) {
    replacementChar = replacementChar || "";
    username = username.toLowerCase();
    // strip illegal chars according to RFC 1459 Sect 2.3.1
    // (technically it's any <nonwhite> ascii for <user> but meh)
    // also strip '_' since we use that as the delimiter
    return username.replace(/[^A-Za-z0-9\]\[\^\\\{\}\-`]/g, replacementChar);
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
        var d = q.defer();
        var generatingUsername = false;
        var info = {};
        // strip illegal chars according to RFC 1459 Sect 2.3.1
        // but allow _ because most IRC servers allow that.
        info.nick = ircUser.nick.replace(/[^A-Za-z0-9\]\[\^\\\{\}\-`_]/g, "");
        if (matrixUser) {
            info.realname = sanitiseRealname(matrixUser.userId);

            if (ircUser.username) {
                log.debug(
                    "Using cached ident username %s for %s on %s",
                    ircUser.username, matrixUser.userId, ircUser.server.domain
                );
                info.username = sanitiseUsername(ircUser.username);
            }
            else {
                generatingUsername = true;
                generateIdentUsername(
                    ircUser.server.domain, matrixUser.userId
                ).done(function(usr) {
                    ircUser.username = usr;
                    info.username = usr;
                    d.resolve(info);
                }, function(e) {
                    log.error(
                        "Failed to generate username for %s : %s",
                        matrixUser.userId, e
                    );
                    d.reject(e);
                });
            }
        }
        else {
            info.username = sanitiseUsername(
                ircUser.username // the bridge won't have a mx user
            );
            info.realname = sanitiseRealname(info.username);
        }
        info.realname = info.realname.substring(0, MAX_REAL_NAME_LENGTH);

        if (!generatingUsername) {
            info.username = info.username.substring(0, MAX_USER_NAME_LENGTH);
            d.resolve(info);
        }

        return d.promise;
    }
};
