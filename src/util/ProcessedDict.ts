import { Logger } from "winston";

/*
Copyright 2019 The Matrix.org Foundation C.I.C.
Copyright 2020 The Matrix.org Foundation C.I.C.

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

const CLEANUP_TIME_MS = 1000 * 60 * 10; // 10min

interface ProcessedSet {
    [domain: string]: {
        [hash: string]: {
            nick: string;
            ts: number|null;
        };
    };
}

export class ProcessedDict {
    processed: ProcessedSet = {};
    private timeoutObj: NodeJS.Timeout|null = null;

    public getClaimer(domain: string, hash: string) {
        if (!this.processed[domain] || !this.processed[domain][hash]) {
            return null;
        }
        return this.processed[domain][hash].nick;
    }

    public claim(domain: string, hash: string, nick: string, cmd: string) {
        if (!this.processed[domain]) {
            this.processed[domain] = {};
        }
        this.processed[domain][hash] = {
            nick: nick,
            // we don't ever want to purge NAMES events
            ts: cmd === "names" ? null : Date.now()
        };
    }

    public startCleaner (parentLog: Logger) {
        const expiredList: {[domain: string]: string[] } = { };
        this.timeoutObj = setTimeout(() => {
            const now = Date.now();
            // loop the processed list looking for entries older than CLEANUP_TIME_MS
            Object.keys(this.processed).forEach((domain) => {
                const entries = this.processed[domain];
                if (!entries) { return; }
                Object.keys(entries).forEach((hash: string) => {
                    const entry = entries[hash];
                    if (entry.ts && (entry.ts + CLEANUP_TIME_MS) < now) {
                        if (!expiredList[domain]) {
                            expiredList[domain] = [];
                        }
                        expiredList[domain].push(hash);
                    }
                });
            });

            // purge the entries
            Object.keys(expiredList).forEach((domain) => {
                const hashes = expiredList[domain];
                parentLog.debug("Cleaning up %s entries from %s", hashes.length, domain);
                hashes.forEach((hash) => {
                    delete this.processed[domain][hash];
                });
            });

            this.startCleaner(parentLog);
        }, CLEANUP_TIME_MS);
    }
}
