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

import { RemoteUser } from "matrix-appservice-bridge";
import { IrcServer } from "../irc/IrcServer";

export class IrcUser extends RemoteUser {

    /**
     * Construct a new IRC user.
     * @constructor
     * @param {IrcServer} server : The IRC server the user is on.
     * @param {string} nick : The nick for this user.
     * @param {boolean} isVirtual : True if the user is not a real IRC user.
     * @param {string} password : The password to give to NickServ.
     * @param {string} username : The username of the client (for ident)
     */
    constructor(
        public readonly server: IrcServer,
        public readonly nick: string,
        public readonly isVirtual: boolean,
        public readonly password: string|null = null,
        username: string|null = null) {
        super(server.domain + "__@__" + nick, {
            domain: server.domain,
            nick: nick,
            isVirtual: Boolean(isVirtual),
            password: password || null,
            username: username || null
        });
    }

    getUsername(): string {
        return this.get("username") as string;
    }

    toString() {
        return `${this.nick} (${this.getUsername()}@${this.server ? this.server.domain : "-"})`;
    }
}
