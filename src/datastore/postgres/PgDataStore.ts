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

import pgInit from "pg-promise";
import { IDatabase, IMain } from "pg-promise";

// eslint-disable-next-line @typescript-eslint/no-duplicate-imports

import { MatrixUser, MatrixRoom, RemoteRoom } from "matrix-appservice-bridge";
import { DataStore, RoomOrigin, ChannelMappings, RoomEntry, UserFeatures } from "../DataStore";
import { IrcRoom } from "../../models/IrcRoom";
import { IrcClientConfig } from "../../models/IrcClientConfig";
import { IrcServer, IrcServerConfig } from "../../irc/IrcServer";

import * as logging from "../../logging";
import Bluebird from "bluebird";
import { stat } from "fs";
import { StringCrypto } from "../StringCrypto";

const pgp: IMain = pgInit({
    // Initialization Options
});

const log = logging.get("PgDatastore");

export class PgDataStore implements DataStore {
    private serverMappings: {[domain: string]: IrcServer} = {};

    public static readonly LATEST_SCHEMA = 1;
    // tslint:disable-next-line: no-any
    private postgresDb: IDatabase<any>;
    private cryptoStore?: StringCrypto;

    constructor(private bridgeDomain: string, connectionString: string, pkeyPath?: string) {
        this.postgresDb = pgp(connectionString);
        if (pkeyPath) {
            this.cryptoStore = new StringCrypto();
            this.cryptoStore.load(pkeyPath);
        }
    }

    public async setServerFromConfig(server: IrcServer, serverConfig: IrcServerConfig): Promise<void> {
        this.serverMappings[server.domain] = server;

        for (const channel of Object.keys(serverConfig.mappings)) {
            const ircRoom = new IrcRoom(server, channel);
            for (const roomId of serverConfig.mappings[channel]) {
                const mxRoom = new MatrixRoom(roomId);
                await this.storeRoom(ircRoom, mxRoom, "config");
            }
        }
    }

    public async storeRoom(ircRoom: IrcRoom, matrixRoom: MatrixRoom, origin: RoomOrigin): Promise<void> {
        if (typeof origin !== "string") {
            throw new Error('Origin must be a string = "config"|"provision"|"alias"|"join"');
        }
        log.info("storeRoom (id=%s, addr=%s, chan=%s, origin=%s)",
            matrixRoom.getId(), ircRoom.getDomain(), ircRoom.channel, origin);
        const statement = PgDataStore.BuildUpsertStatement("rooms","ON CONSTRAINT cons_rooms_unique" , {
            origin,
            type: ircRoom.getType(),
            irc_domain: ircRoom.getDomain(),
            irc_channel: ircRoom.getChannel(),
            room_id: matrixRoom.getId(),
            irc_json: JSON.stringify(ircRoom.serialize()),
            matrix_json: JSON.stringify(matrixRoom.serialize()),
        });
        await this.postgresDb.none(statement);
    }

    private static pgToRoomEntry(pgEntry: any): RoomEntry {
        return {
            id: "",
            matrix: new MatrixRoom(pgEntry.room_id, JSON.parse(pgEntry.matrix_json)),
            remote: new RemoteRoom("", JSON.parse(pgEntry.irc_json)),
            data: {
                origin: pgEntry.origin,
            },
        };
    }

    public async getRoom(roomId: string, ircDomain: string, ircChannel: string, origin?: RoomOrigin): Promise<RoomEntry | null> {
        let statement = "SELECT * FROM rooms WHERE room_id = ${roomId}, irc_domain = ${irc_domain}, irc_channel = ${irc_channel}";
        if (origin) {
            statement += ", origin = ${origin}";
        }
        const pgEntry = await this.postgresDb.oneOrNone(statement, {roomId, ircDomain, ircChannel, origin});
        if (!pgEntry) {
            return null;
        }
        return PgDataStore.pgToRoomEntry(pgEntry);
    }

    public async getAllChannelMappings(): Promise<ChannelMappings> {
        const entries = await this.postgresDb.manyOrNone("SELECT irc_domain, room_id, irc_channel FROM rooms WHERE type = 'channel'");

        const mappings: ChannelMappings = {};
        const validDomains = Object.keys(this.serverMappings);
        entries.forEach((e) => {
            if (!e.room_id) {
                return;
            }
            // Filter out servers we don't know about
            if (!validDomains.includes(e.irc_domain)) {
                return;
            }
            if (!mappings[e.room_id]) {
                mappings[e.room_id] = [];
            }
            mappings[e.room_id].push({
                networkId: this.serverMappings[e.irc_domain].getNetworkId(),
                channel: e.irc_channel,
            });
        })
    
        return mappings;
    }

    public getEntriesByMatrixId(roomId: string): Bluebird<RoomEntry[]> {
        return Bluebird.cast(this.postgresDb.manyOrNone("SELECT * FROM rooms WHERE room_id = ${roomId}", {
            roomId
        })).map((e) => PgDataStore.pgToRoomEntry(e));
    }

    public getProvisionedMappings(roomId: string): Bluebird<RoomEntry[]> {
        return Bluebird.cast(this.postgresDb.manyOrNone("SELECT * FROM rooms WHERE room_id = ${roomId} AND origin = 'provision'", {
            roomId
        })).map((e) => PgDataStore.pgToRoomEntry(e));
    }

    public async removeRoom(roomId: string, ircDomain: string, ircChannel: string, origin: RoomOrigin): Promise<void> {
        await this.postgresDb.none(
            "DELETE FROM rooms WHERE room_id = ${roomId}, irc_domain = ${irc_domain}," + 
            "irc_channel = ${irc_channel}, origin = ${origin}",
            {roomId, ircDomain, ircChannel, origin}
        );
    }

    public async getIrcChannelsForRoomId(roomId: string): Promise<IrcRoom[]> {
        const entries = await this.postgresDb.manyOrNone("SELECT irc_domain, irc_channel FROM rooms WHERE room_id = ${roomId}", {
            roomId
        });
        return entries.map((e) => {
            const server = this.serverMappings[e.irc_domain];
            if (!server) {
                // ! is used here because typescript doesn't understand the .filter
                return undefined!;
            }
            return new IrcRoom(server, e.irc_channel);
        }).filter((i) => i !== undefined);
    }

    public async getIrcChannelsForRoomIds(roomIds: string[]): Promise<{ [roomId: string]: IrcRoom[]; }> {
        const entries = await this.postgresDb.manyOrNone("SELECT room_id, irc_domain, irc_channel FROM rooms WHERE room_id IN ${roomIds}", {
            roomIds
        });
        const mapping: { [roomId: string]: IrcRoom[]; } = {};
        entries.forEach((e) => {
            const server = this.serverMappings[e.irc_domain];
            if (!server) {
                // ! is used here because typescript doesn't understand the .filter
                return;
            }
            if (!mapping[e.room_id]) {
                mapping[e.room_id] = [];
            }
            mapping[e.room_id].push(new IrcRoom(server, e.irc_channel));
        });
        return mapping;
    }

    public async getMatrixRoomsForChannel(server: IrcServer, channel: string): Promise<MatrixRoom[]> {
        const entries = await this.postgresDb.manyOrNone("SELECT room_id, matrix_json FROM rooms WHERE irc_domain = ${domain} AND irc_channel = ${channel}",
        {
            domain: server.domain,
            channel,
        });
        return entries.map((e) => new MatrixRoom(e.room_id, JSON.parse(e.matrix_json)));
    }

    public async getMappingsForChannelByOrigin(server: IrcServer, channel: string, origin: "config" | "provision" | "alias" | "join" | RoomOrigin[], allowUnset: boolean): Promise<RoomEntry[]> {
        const entries = await this.postgresDb.manyOrNone("SELECT * FROM rooms WHERE irc_domain = ${domain} AND irc_channel = ${channel} AND origin = ${origin}",
        {
            domain: server.domain,
            channel,
            origin,
        });
        return entries.map((e) => PgDataStore.pgToRoomEntry(e));
    }

    public async getModesForChannel(server: IrcServer, channel: string): Promise<{ [id: string]: string; }> {
        const mapping: {[id: string]: string} = {};
        const entries = await this.postgresDb.manyOrNone(
            "SELECT room_id, remote_json->>'modes' AS MODES FROM rooms " +
            "WHERE irc_domain = ${domain} AND irc_channel = ${channel}",
        {
            domain: server.domain,
            channel,
        });
        entries.forEach((e) => {
            mapping[e.room_id] = e.modes;
        });
        return mapping;
    }

    public async setModeForRoom(roomId: string, mode: string, enabled: boolean): Promise<void> {
        log.info("setModeForRoom (mode=%s, roomId=%s, enabled=%s)",
            mode, roomId, enabled
        );
        const entries: RoomEntry[] = await this.getEntriesByMatrixId(roomId);
        for (const entry of entries) {
            const modes = entry.remote.get("modes") as string[] || [];
            const hasMode = modes.includes(mode);

            if (hasMode === enabled) {
                continue;
            }
            if (enabled) {
                modes.push(mode);
            }
            else {
                modes.splice(modes.indexOf(mode), 1);
            }

            entry.remote.set("modes", modes);
            await this.postgresDb.none("UPDATE rooms WHERE room_id = ${roomId}, irc_channel = ${channel}, irc_domain = ${domain} SET irc_json = ${data}", {
                roomId,
                channel: entry.remote,
                data: JSON.stringify(entry.remote.serialize()),
            });
        }
    }

    public async setPmRoom(ircRoom: IrcRoom, matrixRoom: any, userId: string, virtualUserId: string): Promise<void> {
        throw new Error("Method not implemented.");
    }

    public async getMatrixPmRoom(realUserId: string, virtualUserId: string): Promise<any> {
        throw new Error("Method not implemented.");
    }

    public async getTrackedChannelsForServer(domain: string): Promise<string[]> {
        if (this.serverMappings[domain]) {
            return [];
        }
        const chanSet = await this.postgresDb.manyOrNone("SELECT channel FROM rooms WHERE irc_domain = ${domain}", { domain });
        return [...new Set((chanSet).map((e) => e.channel))];
    }

    public async getRoomIdsFromConfig(): Promise<string[]> {
        return (
            await this.postgresDb.manyOrNone("SELECT room_id FROM rooms WHERE origin = 'config'")
        ).map((e) => e.room_id);
    }

    public async removeConfigMappings(): Promise<void> {
        await this.postgresDb.none("DELETE FROM rooms WHERE origin = 'config'");
    }

    public async getIpv6Counter(): Promise<number> {
        const res = await this.postgresDb.oneOrNone("SELECT counter FROM ipv6_counter");
        return res ? res.counter : 0;
    }

    public async setIpv6Counter(counter: number): Promise<void> {
        await this.postgresDb.none("UPDATE ipv6_counter SET counter = ${counter}", { counter });
    }

    public async upsertRoomStoreEntry(entry: RoomEntry): Promise<void> {
        throw new Error("Method not implemented.");
    }

    public async getAdminRoomById(roomId: string): Promise<MatrixRoom|null> {
        const res = await this.postgresDb.oneOrNone("SELECT room_id FROM admin_rooms WHERE room_id = ${roomId}", { roomId });
        if (res) {
            return null;
        }
        return new MatrixRoom(roomId);
    }

    public async storeAdminRoom(room: MatrixRoom, userId: string): Promise<void> {
        await this.postgresDb.none(PgDataStore.BuildUpsertStatement("admin_rooms", "(room_id)", {
            room_id: room.getId(),
            user_id: userId,
        }));
    }

    public async getAdminRoomByUserId(userId: string): Promise<MatrixRoom|null> {
        const res = await this.postgresDb.oneOrNone("SELECT room_id FROM admin_rooms WHERE user_id = ${userId}", { userId });
        if (res) {
            return null;
        }
        return new MatrixRoom(res.room_id);
    }

    public async storeMatrixUser(matrixUser: MatrixUser): Promise<void> {
        const statement = PgDataStore.BuildUpsertStatement("matrix_users", "(user_id)", {
            user_id: matrixUser.getId(),
            data: JSON.stringify(matrixUser.serialize()),
        });
        await this.postgresDb.none(statement);
    }

    public async getIrcClientConfig(userId: string, domain: string): Promise<IrcClientConfig | null> {
        const res = await this.postgresDb.oneOrNone("SELECT config, password FROM client_config WHERE user_id = ${userId} and domain = ${domain}", 
        {
            userId,
            domain
        });
        if (!res) {
            return null;
        }
        let config = JSON.parse(res.config);
        if (res.password && this.cryptoStore) {
            config.password = this.cryptoStore.decrypt(res.password);
        }
        return new IrcClientConfig(userId, domain, config);
    }

    public async storeIrcClientConfig(config: IrcClientConfig): Promise<void> {
        const userId = config.getUserId();
        if (!userId) {
            throw Error("IrcClientConfig does not contain a userId");
        }
        let password = undefined;
        if (config.getPassword() && this.cryptoStore) {
            password = this.cryptoStore.encrypt(config.getPassword()!);
        }
        const ketSet = {
            user_id: userId,
            domain: config.getDomain(),
            // either use the decrypted password, or whatever is stored already.
            password: password || config.getPassword()!,
            config: JSON.stringify(config.serialize(true)),
        };
        const statement = PgDataStore.BuildUpsertStatement("client_config", "cons_client_config_unique", ketSet);
        await this.postgresDb.none(statement);
    }

    public async getMatrixUserByLocalpart(localpart: string): Promise<MatrixUser|null> {
        const res = await this.postgresDb.one("SELECT user_id, data FROM matrix_users WHERE user_id = ${userId}", {
            userId: `@${localpart}:${this.bridgeDomain}`,
        });
        if (!res) {
            return null;
        }
        return new MatrixUser(res.user_id, res.data);
    }

    public async getUserFeatures(userId: string): Promise<UserFeatures> {
        const pgRes = (
            await this.postgresDb.oneOrNone("SELECT features FROM user_features WHERE user_id = ${userId}",
            { userId })
        );
        if (pgRes) {
            return JSON.parse(pgRes.features);
        }
        return {};
    }

    public async storeUserFeatures(userId: string, features: UserFeatures): Promise<void> {
        const statement = PgDataStore.BuildUpsertStatement("user_features", "(user_id)", {
            user_id: userId,
            features: JSON.stringify(features),
        });
        await this.postgresDb.none(statement);
    }

    public async storePass(userId: string, domain: string, pass: string): Promise<void> {
        if (!this.cryptoStore) {
            throw Error("Password encryption is not configured.")
        }
        const encryptedPass = this.cryptoStore.encrypt(pass);
        const statement = PgDataStore.BuildUpsertStatement("user_password", "ON CONSTRAINT cons_user_password_unique", {
            user_id: userId,
            domain,
            password: encryptedPass,
        });

        await this.postgresDb.none(statement);
    }

    public async removePass(userId: string, domain: string): Promise<void> {
        await this.postgresDb.none("DELETE FROM user_password WHERE user_id = ${user_id} AND domain = ${domain}");
    }

    public async getMatrixUserByUsername(domain: string, username: string): Promise<void> {
        // This will need a join
        throw new Error("Method not implemented.");
    }

    public async ensureSchema() {
        log.info("Starting postgres database engine");
        let currentVersion = await this.getSchemaVersion();
        while (currentVersion < PgDataStore.LATEST_SCHEMA) {
            log.info(`Updating schema to v${currentVersion + 1}`);
            const runSchema = require(`./schema/v${currentVersion + 1}`).runSchema;
            try {
                await runSchema(this.postgresDb);
                currentVersion++;
                await this.updateSchemaVersion(currentVersion);
            } catch (ex) {
                log.warn(`Failed to run schema v${currentVersion + 1}:`, ex);
                throw Error("Failed to update database schema");
            }
        }
        log.info(`Database schema is at version v${currentVersion}`);
    }

    private async updateSchemaVersion(version: number) {
        log.debug(`updateSchemaVersion: ${version}`);
        await this.postgresDb.none("UPDATE schema SET version = ${version};", {version});
    }

    private async getSchemaVersion(): Promise<number> {
        try {
            const { version } = await this.postgresDb.one("SELECT version FROM SCHEMA");
            return version;
        } catch (ex) {
            if (ex.code === "42P01") { // undefined_table
                log.warn("Schema table could not be found");
                return 0;
            }
            log.error("Failed to get schema version:", ex);
        }
        throw Error("Couldn't fetch schema version");
    }

    private static BuildUpsertStatement(table: string, constraint: string, keyValues: {[key: string]: string}) {
        const keys = Object.keys(keyValues).join(", ");
        const keysValues = `\${${Object.keys(keyValues).join("}, ${")}}`;
        const keysSets = Object.keys(keyValues).slice(1).map((k) => `${k} = \${${k}}`).join(", ");
        return `INSERT INTO ${table} (${keys}) VALUES (${keysValues}) ON CONFLICT ${constraint} DO UPDATE SET ${keysSets}`;
    }
}