/*
Copyright 2019 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { Queue } from "../util/Queue";
import { getLogger } from "../logging";
import { DataStore } from "../datastore/DataStore";
import { MatrixUser } from "matrix-appservice-bridge";
import { IrcClientConfig } from "../models/IrcClientConfig";

const log = getLogger("IdentGenerator");

export class IdentGenerator {
    // The max length of <realname> in USER commands
    private static readonly MAX_REAL_NAME_LENGTH = 48;
    // The max length of <username> in USER commands
    private static readonly MAX_USER_NAME_LENGTH = 10;

    private queue: Queue<{ matrixUser: MatrixUser; ircClientConfig: IrcClientConfig}>;
    constructor (private readonly dataStore: DataStore) {
        // Queue of ident generation requests.
        // We need to queue them because otherwise 2 clashing user_ids could be assigned
        // the same ident value (won't be in the database yet)
        this.queue = new Queue((item) => {
            const {matrixUser, ircClientConfig} = item;
            return this.process(matrixUser, ircClientConfig);
        });
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
    public async getIrcNames(ircClientConfig: IrcClientConfig, matrixUser?: MatrixUser) {
        const username = ircClientConfig.getUsername();
        const info: {username?: string; realname: string} = {
            username: undefined,
            realname: (matrixUser ?
                IdentGenerator.sanitiseRealname(matrixUser.getId()) :
                IdentGenerator.sanitiseRealname(username || "")
                    ).substring(
                            0, IdentGenerator.MAX_REAL_NAME_LENGTH
                    ),
        };
        if (matrixUser) {
            if (username) {
                log.debug(
                    "Using cached ident username %s for %s on %s",
                    ircClientConfig.getUsername(), matrixUser.getId(), ircClientConfig.getDomain()
                );
                info.username = IdentGenerator.sanitiseUsername(username);
                info.username = info.username.substring(
                    0, IdentGenerator.MAX_USER_NAME_LENGTH
                );
            }
            else {
                try {
                    log.debug(
                        "Pushing username generation request for %s on %s to the queue...",
                        matrixUser.getId(), ircClientConfig.getDomain()
                    )
                    const uname = await this.queue.enqueue(matrixUser.getId(), {
                        matrixUser: matrixUser,
                        ircClientConfig: ircClientConfig
                    })
                    info.username = uname as string;
                }
                catch (err) {
                    log.error(
                        "Failed to generate ident username for %s on %s",
                        matrixUser.getId(), ircClientConfig.getDomain()
                    )
                    log.error(err.stack);
                    throw err;
                }
            }
        }
        else if (username) {
            info.username = IdentGenerator.sanitiseUsername(
                username // the bridge won't have a matrix user
            )
        }
        return info;
    }

    // debugging: util.inspect()
    public inspect() {
        return `IdentGenerator queue length=${this.queue.size}`
    }

    private async process (matrixUser: MatrixUser, ircClientConfig: IrcClientConfig) {
        const configDomain = ircClientConfig.getDomain();
        log.debug("Generating username for %s on %s", matrixUser.getId(), configDomain);
        const uname = await this.generateIdentUsername(configDomain, matrixUser.getId());
        const existingConfig = await this.dataStore.getIrcClientConfig(matrixUser.getId(), configDomain);
        const config = existingConfig ? existingConfig : ircClientConfig;
        config.setUsername(uname);

        // persist to db here before releasing the lock on this request.
        await this.dataStore.storeIrcClientConfig(config);
        return config.getUsername();
    }

    /**
     * Generate a new IRC username for the given Matrix user on the given server.
     * @param {string} domain The IRC server domain
     * @param {string} userId The matrix user being bridged
     * @return {Promise} resolves to the username {string}.
     */
    private async generateIdentUsername(domain: string, userId: string) {
        // @foobar££stuff:domain.com  =>  foobar__stuff_domain_com
        let uname = IdentGenerator.sanitiseUsername(userId.substring(1));
        if (uname.length < IdentGenerator.MAX_USER_NAME_LENGTH) { // bwahaha not likely.
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
        const delim = "_";
        const modifyUsername = () => {
            if (uname.indexOf(delim) === -1) {
                uname = uname.substring(0, uname.length - 2) + delim + "1";
                return true;
            }
            const segments = uname.split(delim);
            const oldLen = segments[1].length;
            const num = parseInt(segments[1]) + 1;
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
            const usr = await this.dataStore.getMatrixUserByUsername(domain, uname);
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
    }

    private static sanitiseUsername(username: string, replacementChar = "") {
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

    private static sanitiseRealname(realname: string) {
        // real name can be any old ASCII
        return realname.replace(/[^\x00-\x7F]/g, "");
    }
}
