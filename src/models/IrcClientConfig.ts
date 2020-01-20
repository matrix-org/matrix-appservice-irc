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

import { MatrixUser } from "matrix-appservice-bridge";

export interface IrcClientConfigSeralized {
    username?: string;
    password?: string;
    nick?: string;
    ipv6?: string;
}

/**
 * Contains IRC client configuration, mostly set by Matrix users. Used to configure
 * IrcUsers.
 */
export class IrcClientConfig {

    /**
     * Construct an IRC Client Config.
     * @param {string} userId The user ID who is configuring this config.
     * @param {string} domain The IRC network domain for the IRC client
     * @param {Object} configObj Serialised config information if known.
     */
    constructor(
        public userId: string|null,
        public domain: string,
        private config: IrcClientConfigSeralized = {}) {

    }

    public getDomain() {
        return this.domain;
    }

    public getUserId(): string|null {
        return this.userId;
    }

    public setUsername(uname: string) {
        this.config.username = uname;
    }

    public getUsername(): string|undefined {
        return this.config.username;
    }

    public setPassword(password?: string) {
        this.config.password = password;
    }

    public getPassword(): string|undefined {
        return this.config.password;
    }

    public setDesiredNick(nick: string) {
        this.config.nick = nick;
    }

    public getDesiredNick(): string|undefined {
        return this.config.nick;
    }

    public setIpv6Address(address: string) {
        this.config.ipv6 = address;
    }

    public getIpv6Address(): string|undefined {
        return this.config.ipv6;
    }

    public serialize(removePassword = false) {
        if (removePassword) {
            const clone = JSON.parse(JSON.stringify(this.config));
            delete clone.password;
            return clone;
        }
        return this.config;
    }

    public toString() {
        const redactedConfig = {
            username: this.config.username,
            nick: this.config.nick,
            ipv6: this.config.ipv6,
            password: this.config.password ? '<REDACTED>' : undefined,
        };
        return this.userId + "=>" + this.domain + "=" + JSON.stringify(redactedConfig);
    }

    public static newConfig(matrixUser: MatrixUser|null, domain: string,
                            nick?: string, username?: string, password?: string) {
        return new IrcClientConfig(matrixUser ? matrixUser.getId() : null, domain, {
            nick: nick,
            username: username,
            password: password
        });
    }
}
