/*eslint no-invalid-this: 0 no-constant-condition: 0 */
"use strict";
var Promise = require("bluebird");
var Queue = require("../util/Queue");
var log = require("../logging").get("IdentGenerator");

function IdentGenerator(store) {
    // Queue of ident generation requests.
    // We need to queue them because otherwise 2 clashing user_ids could be assigned
    // the same ident value (won't be in the database yet)
    this.queue = new Queue(this._process.bind(this));
    this.dataStore = store;
}

// debugging: util.inspect()
IdentGenerator.prototype.inspect = function(depth) {
    return "IdentGenerator queue length=" +
        (this.queue._queue ?
            this.queue._queue.length : -1);
}


/**
 * Get the IRC name info for this user.
 * @param {IrcClientConfig} clientConfig IRC client configuration info.
 * @param {MatrixUser} matrixUser Optional. The matrix user.
 * @return {Promise} Resolves to {
 *   username: 'username_to_use',
 *   realname: 'realname_to_use'
 * }
 */
IdentGenerator.prototype.getIrcNames = Promise.coroutine(function*(ircClientConfig, matrixUser) {
    var info = {
        username: null,
        realname: (matrixUser ?
                    sanitiseRealname(matrixUser.getId()) :
                    sanitiseRealname(ircClientConfig.getUsername())
                  ).substring(
                        0, IdentGenerator.MAX_REAL_NAME_LENGTH
                  )
    };
    if (matrixUser) {
        if (ircClientConfig.getUsername()) {
            log.debug(
                "Using cached ident username %s for %s on %s",
                ircClientConfig.getUsername(), matrixUser.getId(), ircClientConfig.getDomain()
            );
            info.username = sanitiseUsername(ircClientConfig.getUsername());
            info.username = info.username.substring(
                0, IdentGenerator.MAX_USER_NAME_LENGTH
            );
        }
        else {
            try {
                log.debug(
                    "Pushing username generation request for %s on %s to the queue...",
                    matrixUser.getId(), ircClientConfig.getDomain()
                );
                let uname = yield this.queue.enqueue(matrixUser.getId(), {
                    matrixUser: matrixUser,
                    ircClientConfig: ircClientConfig
                });
                info.username = uname;
            }
            catch (err) {
                log.error(
                    "Failed to generate ident username for %s on %s",
                    matrixUser.getId(), ircClientConfig.getDomain()
                );
                log.error(err.stack);
                throw err;
            }
        }
    }
    else {
        info.username = sanitiseUsername(
            ircClientConfig.getUsername() // the bridge won't have a matrix user
        );
    }
    return info;
});

IdentGenerator.prototype._process = Promise.coroutine(function*(item) {
    var matrixUser = item.matrixUser;
    var ircClientConfig = item.ircClientConfig;
    var configDomain = ircClientConfig.getDomain();

    log.debug(
        "Generating username for %s on %s", matrixUser.getId(), configDomain
    );
    let uname = yield this._generateIdentUsername(
        configDomain, matrixUser.getId()
    );
    let existingConfig = yield this.dataStore.getIrcClientConfig(
        matrixUser.getId(), configDomain
    );
    let config = existingConfig ? existingConfig : ircClientConfig;
    config.setUsername(uname);

    // persist to db here before releasing the lock on this request.
    yield this.dataStore.storeIrcClientConfig(config);
    return config.getUsername();
});

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

function sanitiseUsername(username, replacementChar) {
    replacementChar = replacementChar || ""; // default remove chars
    username = username.toLowerCase();
    // strip illegal chars according to RFC 1459 Sect 2.3.1
    // (technically it's any <nonwhite> ascii for <user> but meh)
    // also strip '_' since we use that as the delimiter
    username = username.replace(/[^A-Za-z0-9\]\[\^\\\{\}\-`]/g, replacementChar);
    // Whilst the RFC doesn't say you can't have special characters eg ("-") as the
    // first character of a USERNAME, empirically Freenode rejects connections
    // stating "Invalid username". Having  "-" is valid, so long as it isn't the first.
    // Prefix usernames with "M" if they start with a special character.
    if (/^[^A-Za-z]/.test(username)) {
        return "M" + username;
    }
    return username;
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
