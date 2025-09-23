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
import { IrcClientConfig } from "../models/IrcClientConfig";
import { IrcServer } from "./IrcServer";
import { MatrixUser } from "matrix-appservice-bridge";

const log = getLogger("Ipv6Generator");

export class Ipv6Generator {
    private counter = new Map<string, number>();
    private queue: Queue<{prefix: string; ircClientConfig: IrcClientConfig, server: IrcServer}>;
    constructor (private readonly dataStore: DataStore) {
        // Queue of ipv6 generation requests.
        // We need to queue them because otherwise 2 clashing user_ids could be assigned
        // the same ipv6 value (won't be in the database yet)
        this.queue = new Queue((item) => {
            return this.process(item.prefix, item.ircClientConfig, item.server);
        });
    }

    public getCounterKey(userId: string|null, server: IrcServer) {
        if (!userId) {
            // Bot uses the global pool.
            return server.domain;
        }
        const homeserver = new MatrixUser(userId).host;
        if (server.getIpv6BlockForHomeserver(homeserver)) {
            return `${server.domain}/${homeserver}`;
        }
        return server.domain;
    }

    /**
     * Generate a new IPv6 address for the given IRC client config.
     * @param {string} prefix The IPv6 prefix to use.
     * @param {IrcClientConfig} ircClientConfig The config to set the address on.
     * @return {Promise} Resolves to the IPv6 address generated; the IPv6 address will
     * already be set on the given config.
     */
    public async generate (prefix: string, ircClientConfig: IrcClientConfig, server: IrcServer): Promise<string> {
        const existingAddress = ircClientConfig.getIpv6Address();
        const userId = ircClientConfig.getUserId();
        if (existingAddress) {
            log.debug(
                "Using existing IPv6 address %s for %s",
                existingAddress,
                userId,
            );
            return existingAddress;
        }
        // the bot user will not have a user ID
        const id = ircClientConfig.getUserId() || ircClientConfig.getUsername();
        if (!id) {
            throw Error("Neither a userId or username were provided to generate.");
        }
        log.debug("Enqueueing IPv6 generation request for %s", id);
        return (await this.queue.enqueue(id, {
            prefix: prefix,
            ircClientConfig: ircClientConfig,
            server: server,
        })) as string;
    }

    public async process (prefix: string, ircClientConfig: IrcClientConfig, server: IrcServer) {
        const userId = ircClientConfig.getUserId();
        const homeserver = userId && new MatrixUser(userId).host;
        const counterKey = this.getCounterKey(userId, server);
        const isInBlock = !!(homeserver && server.getIpv6BlockForHomeserver(homeserver));
        let counter = this.counter.get(counterKey);
        // This function should never be called asyncronously, as it's backed by a queue.
        // We should be safe to pull out counter values here.
        if (typeof counter !== "number") {
            log.debug(`Retrieving counter ${counterKey}`);
            counter = await this.dataStore.getIpv6Counter(server, isInBlock ? homeserver : null);
            this.counter.set(counterKey, counter);
        }
        counter += 1;
        this.counter.set(counterKey, counter);
        let ipv6CounterSuffix: number = counter;
        if (homeserver) {
            // If this homeserver has been put in a special block, append
            // the start range to the counter.
            const block = server.getIpv6BlockForHomeserver(homeserver);
            if (block) {
                ipv6CounterSuffix = counter + parseInt(block.replace(/:/g, ''), 16);
            }
        }

        // insert : every 4 characters from the end of the string going to the start
        // e.g. 1a2b3c4d5e6 => 1a2:b3c4:d5e6
        const suffix = ipv6CounterSuffix.toString(16).replace(/\B(?=(.{4})+(?!.))/g, ':');
        const address = prefix + suffix;

        let config = ircClientConfig;
        config.setIpv6Address(address);

        // we only want to persist the IPv6 address for real matrix users
        if (userId) {
            const existingConfig = await this.dataStore.getIrcClientConfig(
                userId, ircClientConfig.getDomain()
            );
            if (existingConfig) {
                config = existingConfig;
                config.setIpv6Address(address);
            }
            log.info("Generated new IPv6 address %s for %s", address, config.getUserId());
            // persist to db here before releasing the lock on this request.
            await this.dataStore.storeIrcClientConfig(config);
        }

        await this.dataStore.setIpv6Counter(counter, server, isInBlock ? homeserver : null);
        return config.getIpv6Address();
    }
}
