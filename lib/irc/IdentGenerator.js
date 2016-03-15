/*eslint no-invalid-this: 0 no-constant-condition: 0 */
"use strict";
var Promise = require("bluebird");
var promiseutil = require("../promiseutil");
var IrcClientConfig = require("../models/IrcClientConfig");
var log = require("../logging").get("irc-names");

function IdentGenerator(store) {
    // Queue of ident generation requests.
    // We need to queue them because otherwise 2 clashing user_ids could be assigned
    // the same ident value (won't be in the database yet)
    this.queue = [];
    this.processing = null;
    this.dataStore = store;
}


/**
 * Get the IRC name info for this user.
 * @param {IrcUser} ircUser The IRC user to connect as.
 * @param {MatrixUser} matrixUser Optional. The matrix user.
 * @return {Promise} Resolves to {
 *   nick: 'nick_to_use',
 *   username: 'username_to_use',
 *   realname: 'realname_to_use'
 * }
 */
IdentGenerator.prototype.getIrcNames = function(ircUser, matrixUser) {
    var d = promiseutil.defer();
    var generatingUsername = false;
    var info = {};
    // strip illegal chars according to RFC 1459 Sect 2.3.1
    // but allow _ because most IRC servers allow that.
    info.nick = ircUser.nick.replace(/[^A-Za-z0-9\]\[\^\\\{\}\-`_]/g, "");
    if (matrixUser) {
        info.realname = sanitiseRealname(matrixUser.getId());

        if (ircUser.getUsername()) {
            log.debug(
                "Using cached ident username %s for %s on %s",
                ircUser.getUsername(), matrixUser.getId(), ircUser.server.domain
            );
            info.username = sanitiseUsername(ircUser.getUsername());
        }
        else {
            generatingUsername = true;
            var queueDefer = promiseutil.defer();
            this.queue.push({
                matrixUser: matrixUser,
                ircUser: ircUser,
                defer: queueDefer
            });
            log.debug(
                "Pushed username generation request for %s on %s to the queue...",
                matrixUser.getId(), ircUser.server.domain
            );
            queueDefer.promise.done(function(uname) {
                info.username = uname;
                d.resolve(info);
            }, function(err) {
                log.error(
                    "Failed to generate ident username for %s on %s : %s",
                    matrixUser.getId(), ircUser.server.domain, err
                );
                d.reject(err);
            });
            this._checkQueue();
        }
    }
    else {
        info.username = sanitiseUsername(
            ircUser.getUsername() // the bridge won't have a mx user
        );
        info.realname = sanitiseRealname(info.username);
    }
    info.realname = info.realname.substring(
        0, IdentGenerator.MAX_REAL_NAME_LENGTH
    );

    if (!generatingUsername) {
        info.username = info.username.substring(
            0, IdentGenerator.MAX_USER_NAME_LENGTH
        );
        d.resolve(info);
    }
    return d.promise;
};

/**
 * Generate a new IRC username for the given Matrix user on the given server.
 * @param {string} domain The IRC server domain
 * @param {string} userId The matrix user being bridged
 * @return {Promise} resolves to the username {string}.
 */
IdentGenerator.prototype._generateIdentUsername = Promise.coroutine(function*(domain, userId) {
    // @foobar££stuff:domain.com  =>  foobar__stuff_domain_com
    var uname = sanitiseUsername(userId.substring(1));
    if (uname < IdentGenerator.MAX_USER_NAME_LENGTH) { // bwahaha not likely.
        return uname;
    }
    uname = uname.substring(0, IdentGenerator.MAX_USER_NAME_LENGTH);
    /* LONGNAM~1 ing algorithm:
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

    // TODO: This isn't efficient currently; since this will be called worst
    // case 10^[num chars in string] => 10^10
    // We should instead be querying to extract the max occupied number for
    // that char string (which is worst case [num chars in string]), e.g.
    // fooba => 9, foob => 99, foo => 999, fo => 4523 = fo~4524
    while (true) {
        let usr = yield this.dataStore.getMatrixUserByUsername(domain, uname);
        if (usr && usr.getId() !== userId) { // occupied username!
            if (!modifyUsername()) {
                throw new Error("Ran out of entries: " + uname);
            }
        }
        else {
            if (!usr) {
                log.info(
                    "Generated ident username %s for %s on %s",
                    uname, userId, domain
                );
            }
            else {
                log.info(
                    "Returning cached ident username %s for %s on %s",
                    uname, userId, domain
                );
            }
            break;
        }
    }
    return uname;
});

IdentGenerator.prototype._checkQueue = Promise.coroutine(function*() {
    if (!this.processing) {
        this.processing = this.queue.shift();
        if (!this.processing) {
            log.debug("Queue is empty.");
            return;
        }
        var matrixUser = this.processing.matrixUser;
        var ircUser = this.processing.ircUser;
        var defer = this.processing.defer;

        try {
            log.debug(
                "Generating username for %s on %s (new queue length = %s)",
                matrixUser.getId(), ircUser.server.domain, this.queue.length
            );
            let uname = yield this._generateIdentUsername(
                ircUser.server.domain, matrixUser.getId()
            );

            ircUser.setUsername(uname);
            let config = yield this.dataStore.getIrcClientConfig(
                matrixUser.getId(), ircUser.server.domain
            );

            // persist to db here before releasing the lock on this
            // request.
            if (!config) {
                config = IrcClientConfig.newConfig(matrixUser, ircUser);
            }
            else if (config.getUsername() !== ircUser.getUsername()) {
                log.error(
                    "Generated username %s but stored config has %s. Using %s",
                    ircUser.getUsername(), config.getUsername(), ircUser.getUsername()
                );
                config.setUsername(ircUser.getUsername());
            }
            yield this.dataStore.storeIrcClientConfig(config);
            defer.resolve(ircUser.getUsername());
        }
        catch (err) {
            log.error(
                "Failed to generate username for %s : %s",
                matrixUser.getId(), err
            );
            defer.reject(err);
        }
        finally {
            this.processing = null;
            this._checkQueue();
        }
    }
    else {
        log.debug(
            "Already generating for %s on %s",
            this.processing.matrixUser.getId(), this.processing.ircUser.server.domain
        );
    }
});

function sanitiseUsername(username, replacementChar) {
    replacementChar = replacementChar || "";
    username = username.toLowerCase();
    // strip illegal chars according to RFC 1459 Sect 2.3.1
    // (technically it's any <nonwhite> ascii for <user> but meh)
    // also strip '_' since we use that as the delimiter
    return username.replace(/[^A-Za-z0-9\]\[\^\\\{\}\-`]/g, replacementChar);
}

function sanitiseRealname(realname) {
    // real name can be any old ASCII
    return realname.replace(/[^\x00-\x7F]/g, "");
}

// The max length of <realname> in USER commands
IdentGenerator.MAX_REAL_NAME_LENGTH = 48;

// The max length of <username> in USER commands
IdentGenerator.MAX_USER_NAME_LENGTH = 10;


module.exports = IdentGenerator;
