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

const log = getLogger("Ipv6Generator");

export class Ipv6Generator {
    private counter = -1;
    private queue: Queue<{prefix: string; ircClientConfig: IrcClientConfig}>;
    constructor (private readonly dataStore: DataStore) {
        // Queue of ipv6 generation requests.
        // We need to queue them because otherwise 2 clashing user_ids could be assigned
        // the same ipv6 value (won't be in the database yet)
        this.queue = new Queue((item) => {
            return this.process(item.prefix, item.ircClientConfig);
        });
    }

    // debugging: util.inspect()
    public inspect () {
        return `IPv6Counter=${this.counter},Queue.length=${this.queue.size}`;
    }

    /**
     * Generate a new IPv6 address for the given IRC client config.
     * @param {string} prefix The IPv6 prefix to use.
     * @param {IrcClientConfig} ircClientConfig The config to set the address on.
     * @return {Promise} Resolves to the IPv6 address generated; the IPv6 address will
     * already be set on the given config.
     */
    public async generate (prefix: string, ircClientConfig: IrcClientConfig): Promise<string> {
        const existingAddress = ircClientConfig.getIpv6Address();
        if (existingAddress) {
            log.info(
                "Using existing IPv6 address %s for %s",
                existingAddress,
                ircClientConfig.getUserId()
            );
            return existingAddress;
        }
        if (this.counter === -1) {
            log.info("Retrieving counter...");
            this.counter = await this.dataStore.getIpv6Counter();
        }

        // the bot user will not have a user ID
        const id = ircClientConfig.getUserId() || ircClientConfig.getUsername();
        if (!id) {
            throw Error("Neither a userId or username were provided to generate.");
        }
        log.info("Enqueueing IPv6 generation request for %s", id);
        return (await this.queue.enqueue(id, {
            prefix: prefix,
            ircClientConfig: ircClientConfig
        })) as string;
    }

    public async process (prefix: string, ircClientConfig: IrcClientConfig) {
        this.counter += 1;

        // insert : every 4 characters from the end of the string going to the start
        // e.g. 1a2b3c4d5e6 => 1a2:b3c4:d5e6
        const suffix = this.counter.toString(16).replace(/\B(?=(.{4})+(?!.))/g, ':');
        const address = prefix + suffix;

        let config = ircClientConfig;
        config.setIpv6Address(address);

        const userId = ircClientConfig.getUserId();
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

        await this.dataStore.setIpv6Counter(this.counter);
        return config.getIpv6Address();
    }
}
