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

import { getLogger, newRequestLogger, RequestLogger } from "../logging";
import { Request } from "matrix-appservice-bridge";
import { LoggerInstance } from "winston";
const log = getLogger("req");

export class BridgeRequest {
    log: RequestLogger;
    constructor(private req: Request) {
        const isFromIrc = req.getData() ? Boolean(req.getData().isFromIrc) : false;
        this.log = newRequestLogger(log as LoggerInstance, req.getId(), isFromIrc);
    }

    getPromise() {
        return this.req.getPromise();
    }

    resolve(thing?: unknown) {
        this.req.resolve(thing);
    }

    reject(err?: unknown) {
        this.req.reject(err);
    }
}

export enum BridgeRequestErr {
    ERR_VIRTUAL_USER,
    ERR_NOT_MAPPED,
    ERR_DROPPED,
}
