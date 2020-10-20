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

import { RemoteRoom } from "matrix-appservice-bridge";
import { toIrcLowerCase } from "../irc/formatting";
import { IrcServer } from "../irc/IrcServer";

export class IrcRoom extends RemoteRoom {
    /**
     * Construct a new IRC room.
     * @constructor
     * @param {IrcServer} server : The IRC server which contains this room.
     * @param {String} channel : The channel this room represents.
     */
    constructor(public readonly server: IrcServer, public readonly channel: string) {
        // Because `super` must be called first, we convert the case several times.
        super(IrcRoom.createId(server, toIrcLowerCase(channel)), {
            domain: server.domain,
            channel: toIrcLowerCase(channel),
            type: channel.startsWith("#") ? "channel" : "pm"
        });
        if (!server || !channel) {
            throw new Error("Server and channel are required.");
        }
        channel = toIrcLowerCase(channel);
    }

    getDomain() {
        return super.get("domain") as string;
    }

    getServer() {
        return this.server;
    }

    getChannel() {
        return super.get("channel") as string;
    }

    getType() {
        return super.get("type") as "channel"|"pm";
    }

    public static fromRemoteRoom(server: IrcServer, remoteRoom: RemoteRoom) {
        return new IrcRoom(server, remoteRoom.get("channel") as string);
    }

    // An IRC room is uniquely identified by a combination of the channel name and the
    // IRC network the channel resides on. Space is the delimiter because neither the
    // domain nor the channel allows spaces.
    public static createId(server: {domain: string}, channel: string) {
        return server.domain + " " + channel;
    }
}
