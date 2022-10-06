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
import {
    MatrixUser,
    MatrixRoom,
    RemoteRoom,
    RoomBridgeStoreEntry as Entry,
    MatrixRoomData,
    UserActivitySet,
    UserActivity,
    PostgresStore,
} from "matrix-appservice-bridge";
import { DataStore, RoomOrigin, ChannelMappings, UserFeatures } from "../DataStore";
import { MatrixDirectoryVisibility } from "../../bridge/IrcHandler";
import { IrcRoom } from "../../models/IrcRoom";
import { IrcClientConfig } from "../../models/IrcClientConfig";
import { IrcServer, IrcServerConfig } from "../../irc/IrcServer";

import { getLogger } from "../../logging";
import { StringCrypto } from "../StringCrypto";
import { toIrcLowerCase } from "../../irc/formatting";
import { NeDBDataStore } from "../NedbDataStore";
import QuickLRU from "quick-lru";
import schemas from './schema';

const log = getLogger("PgDatastore");

const FEATURE_CACHE_SIZE = 512;

interface RoomRecord {
    room_id: string;
    irc_domain: string;
    irc_channel: string;
    matrix_json?: MatrixRoomData;
    irc_json: Record<string, unknown>;
    type: string;
    origin: RoomOrigin;
}

export class PgDataStore extends PostgresStore implements DataStore {
    private serverMappings: {[domain: string]: IrcServer} = {};
    private cryptoStore?: StringCrypto;
    private userFeatureCache = new QuickLRU<string, UserFeatures>({
        maxSize: FEATURE_CACHE_SIZE,
    });

    constructor(private bridgeDomain: string, connectionString: string, pkeyPath?: string, max = 4) {
        super(schemas, {
            url: connectionString,
            max,
        });
        if (pkeyPath) {
            this.cryptoStore = new StringCrypto();
            this.cryptoStore.load(pkeyPath);
        }
    }

    public async setServerFromConfig(server: IrcServer, serverConfig: IrcServerConfig): Promise<void> {
        this.serverMappings[server.domain] = server;

        for (const channel of Object.keys(serverConfig.mappings)) {
            const ircRoom = new IrcRoom(server, channel);
            ircRoom.set("type", "channel");
            for (const roomId of serverConfig.mappings[channel].roomIds) {
                const mxRoom = new MatrixRoom(roomId);
                await this.storeRoom(ircRoom, mxRoom, "config");
            }
        }
    }

    public async storeRoom(ircRoom: IrcRoom, matrixRoom: MatrixRoom, origin: RoomOrigin): Promise<void> {
        if (typeof origin !== "string") {
            throw new Error('Origin must be a string = "config"|"provision"|"alias"|"join"');
        }
        log.info("storeRoom (id=%s, addr=%s, chan=%s, origin=%s, type=%s)",
            matrixRoom.getId(), ircRoom.getDomain(), ircRoom.channel, origin, ircRoom.getType());
        // We need to *clone* this as we are about to be evil.
        const ircRoomSerial = JSON.parse(JSON.stringify(ircRoom.serialize()));
        // These keys do not need to be stored inside the JSON blob as we store them
        // inside dedicated columns. They will be reinserted into the JSON blob
        // when fetched.
        const type = ircRoom.getType();
        const domain = ircRoom.getDomain();
        const channel = ircRoom.getChannel();
        delete ircRoomSerial.domain;
        delete ircRoomSerial.channel;
        delete ircRoomSerial.type;
        await this.upsertRoom(
            origin,
            type,
            domain,
            channel,
            matrixRoom.getId(),
            JSON.stringify(ircRoomSerial),
            JSON.stringify(matrixRoom.serialize()),
        );
    }

    public async upsertRoom(
        origin: RoomOrigin,
        type: string,
        domain: string,
        channel: string,
        roomId: string,
        ircJson: string,
        matrixJson: string
    ) {
        const parameters = {
            origin,
            type,
            irc_domain: domain,
            irc_channel: channel,
            room_id: roomId,
            irc_json: ircJson,
            matrix_json: matrixJson,
        };
        await this.sql`INSERT INTO rooms ${this.sql(parameters)}
            ON CONFLICT cons_rooms_unique
            DO UPDATE SET ${this.sql(parameters)}`;
    }

    private static pgToRoomEntry(pgEntry: RoomRecord): Entry {
        return {
            id: NeDBDataStore.createMappingId(pgEntry.room_id, pgEntry.irc_domain, pgEntry.irc_channel),
            matrix: new MatrixRoom(pgEntry.room_id, pgEntry.matrix_json),
            remote: new RemoteRoom("",
                {
                    ...pgEntry.irc_json,
                    channel: pgEntry.irc_channel,
                    domain: pgEntry.irc_domain,
                    type: pgEntry.type,
                }),
            data: {
                origin: pgEntry.origin,
            },
        };
    }

    public async getRoom(
        roomId: string,
        ircDomain: string,
        ircChannel: string,
        origin?: RoomOrigin
    ): Promise<Entry | null> {
        let statement = `SELECT * FROM rooms
        WHERE room_id = ${roomId}
        AND irc_domain = ${ircDomain} 
        AND irc_channel = ${ircChannel}`;
        if (origin) {
            statement += ` AND origin = ${origin}`;
        }
        const pgEntry = await this.sql<RoomRecord[]>`${statement}`;
        if (!pgEntry?.length) {
            return null;
        }
        return PgDataStore.pgToRoomEntry(pgEntry[0]);
    }

    public async getAllChannelMappings(): Promise<ChannelMappings> {
        const entries = this.sql<{
            irc_domain: string,
            room_id: string,
            irc_channel: string
        }[]>`SELECT irc_domain, room_id, irc_channel FROM rooms WHERE type = 'channel'`;

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

    public async getEntriesByMatrixId(roomId: string): Promise<Entry[]> {
        const entries = await this.sql<RoomRecord[]>`SELECT * FROM rooms WHERE room_id = ${roomId}`;
        return entries.flatMap((e) => PgDataStore.pgToRoomEntry(e));
    }

    public async getProvisionedMappings(roomId: string): Promise<Entry[]> {
        const res = await this.sql<RoomRecord[]>`
        SELECT *
        FROM rooms
        WHERE room_id = ${roomId}
        AND origin = 'provision'`;
        return res.map((e) => PgDataStore.pgToRoomEntry(e));
    }

    public async removeRoom(roomId: string, ircDomain: string, ircChannel: string, origin?: RoomOrigin): Promise<void> {
        let statement = `DELETE FROM rooms
        WHERE room_id = ${roomId}
        AND irc_domain = ${ircDomain}
        AND irc_channel = ${ircChannel}`;
        if (origin) {
            statement += ` AND origin = ${origin}`;
        }
        await this.sql`${statement}`;
    }

    public async getIrcChannelsForRoomId(roomId: string): Promise<IrcRoom[]> {
        let entries = await this.sql`SELECT irc_domain, irc_channel FROM rooms WHERE room_id = ${roomId}`;
        if (entries.length === 0) {
            // Could be a PM room, if it's not a channel.
            entries = await this.sql`SELECT irc_domain, irc_nick FROM pm_rooms WHERE room_id = ${roomId}`;
        }
        const rooms: IrcRoom[] = [];
        for (const row of entries) {
            const server = this.serverMappings[row.irc_domain];
            if (server) {
                rooms.push(new IrcRoom(server, row.irc_channel || row.irc_nick));
            }
        }
        return rooms;
    }

    public async getIrcChannelsForRoomIds(roomIds: string[]): Promise<{ [roomId: string]: IrcRoom[] }> {
        const entries = await this.sql`SELECT room_id, irc_domain, irc_channel FROM rooms WHERE room_id IN ${roomIds}`;
        const mapping: { [roomId: string]: IrcRoom[] } = {};
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
        const entries = await this.sql`SELECT room_id, matrix_json
        FROM rooms
        WHERE irc_domain = ${server.domain}
        AND irc_channel = ${toIrcLowerCase(channel)}`;
        return entries.map((e) => new MatrixRoom(e.room_id, e.matrix_json));
    }

    public async getMappingsForChannelByOrigin(
        server: IrcServer,
        channel: string,
        origin: RoomOrigin | RoomOrigin[],
    ): Promise<Entry[]> {
        if (!Array.isArray(origin)) {
            origin = [origin];
        }
        const entries = await this.sql<RoomRecord[]>`SELECT *
        FROM rooms
        WHERE irc_domain = ${server.domain}
        AND irc_channel = ${toIrcLowerCase(channel)}
        AND origin IN (${origin})`;
        return entries.map((e) => PgDataStore.pgToRoomEntry(e));
    }

    public async getModesForChannel(server: IrcServer, channel: string): Promise<{ [id: string]: string[] }> {
        log.debug(`Getting modes for ${server.domain} ${channel}`);
        const mapping: {[id: string]: string[]} = {};
        const entries = await this.sql`SELECT room_id, irc_json->>'modes' AS modes
        FROM rooms
        WHERE irc_domain = ${server.domain}
        AND irc_channel = ${toIrcLowerCase(channel)}`;
        entries.forEach((e) => {
            mapping[e.room_id] = e.modes || [];
        });
        return mapping;
    }

    public async setModeForRoom(roomId: string, mode: string, enabled: boolean): Promise<void> {
        log.info("setModeForRoom (mode=%s, roomId=%s, enabled=%s)",
            mode, roomId, enabled
        );
        const entries: Entry[] = await this.getEntriesByMatrixId(roomId);
        for (const entry of entries) {
            if (!entry.remote) {
                continue;
            }
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
            // Clone the object
            const ircRoomSerial = JSON.parse(JSON.stringify(entry.remote.serialize()));
            delete ircRoomSerial.domain;
            delete ircRoomSerial.channel;
            delete ircRoomSerial.type;
            const channel = entry.remote.get<string>("channel");
            const domain = entry.remote.get<string>("domain");
            await this.sql`UPDATE rooms
            WHERE room_id = ${roomId}
            SET irc_json = ${JSON.stringify(ircRoomSerial)}
            AND irc_channel = ${channel}
            AND irc_domain = ${domain}`;
        }
    }

    public async setPmRoom(ircRoom: IrcRoom, matrixRoom: MatrixRoom, userId: string,
                           virtualUserId: string
    ): Promise<void> {
        log.debug(`setPmRoom (matrix_user_id=${userId}, virtual_user_id=${virtualUserId}, ` +
            `room_id=${matrixRoom.getId()}, irc_nick=${ircRoom.getChannel()})`);
        const data = {
            room_id: ircRoom.roomId,
            irc_domain: ircRoom.getDomain(),
            irc_nick: ircRoom.getChannel(),
            matrix_user_id: userId,
            virtual_user_id: virtualUserId,
        };
        await this.sql`INSERT INTO pm_rooms ${this.sql(data)}
        ON CONSTRAINT cons_pm_rooms_matrix_irc_unique
        DO UPDATE SET ${this.sql(data)}`;
    }

    public async removePmRoom(roomId: string): Promise<void> {
        log.debug(`removePmRoom (room_id=${roomId}`);
        await this.sql`DELETE FROM pm_rooms WHERE room_id = ${roomId}`;
    }

    public async getMatrixPmRoom(realUserId: string, virtualUserId: string): Promise<MatrixRoom|null> {
        log.debug(`getMatrixPmRoom (matrix_user_id=${realUserId}, virtual_user_id=${virtualUserId})`);
        const res = await this.sql`SELECT room_id
        FROM pm_rooms
        WHERE matrix_user_id = ${realUserId}
        AND virtual_user_id = ${virtualUserId}`;
        return res?.[0] ? new MatrixRoom(res[0].room_id) : null;
    }

    public async getMatrixPmRoomById(roomId: string): Promise<MatrixRoom|null> {
        log.debug(`getMatrixPmRoom (roomId=${roomId})`);
        const res = await this.sql`SELECT room_id, matrix_user_id, virtual_user_id
        FROM pm_rooms
        WHERE room_id = ${roomId}`;
        return res?.[0] ? new MatrixRoom(res[0].room_id) : null;
    }

    public async getTrackedChannelsForServer(domain: string): Promise<string[]> {
        if (!this.serverMappings[domain]) {
            // Return empty if we don't know the server.
            return [];
        }
        log.info(`Fetching all channels for ${domain}`);
        const chanSet = await this.sql`SELECT DISTINCT irc_channel FROM rooms WHERE irc_domain = ${domain}`;
        return chanSet.map((e) => e.irc_channel as string);
    }

    public async getRoomIdsFromConfig(): Promise<string[]> {
        return (
            await this.sql`SELECT room_id FROM rooms WHERE origin = 'config'`
        ).map((e) => e.room_id);
    }

    public async removeConfigMappings(): Promise<void> {
        await this.sql`DELETE FROM rooms WHERE origin = 'config'`;
    }

    public async getIpv6Counter(server: IrcServer, homeserver: string|null): Promise<number> {
        homeserver = homeserver || "*";
        const res = await this.sql`SELECT count
        FROM ipv6_counter
        WHERE server = ${server.domain}
        AND homeserver = ${homeserver}`;
        return parseInt(res?.[0]?.count, 10) || 0;
    }

    public async setIpv6Counter(count: number, server: IrcServer, homeserver: string|null): Promise<void> {
        const data = {count, homeserver: homeserver || "*", server: server.domain};
        await this.sql`INSERT INTO ipv6_counter ${this.sql(data)}
            ON CONSTRAINT cons_ipv6_counter_unique
            DO UPDATE SET count = ${count}`;
    }

    public async upsertMatrixRoom(room: MatrixRoom): Promise<void> {
        // XXX: This is an upsert operation, but we don't have enough details to go on
        // so this will just update a rooms data entry. We only use this call to update
        // topics on an existing room.
        await this.sql`UPDATE rooms
        SET matrix_json = ${JSON.stringify(room.serialize())}
        WHERE room_id = ${room.getId()}`;
    }

    public async getAdminRoomById(roomId: string): Promise<MatrixRoom|null> {
        const res = await this.sql`SELECT room_id FROM admin_rooms WHERE room_id = ${roomId}`;
        return res?.[0] ? new MatrixRoom(res?.[0].room_id) : null;
    }

    public async storeAdminRoom(room: MatrixRoom, userId: string): Promise<void> {
        await this.sql`INSERT INTO admin_rooms ${this.sql({room_id: room.getId(), user_id: userId})}`;
    }

    public async getAdminRoomByUserId(userId: string): Promise<MatrixRoom|null> {
        const res = await this.sql`SELECT room_id FROM admin_rooms WHERE user_id = ${userId}`;
        return res?.[0] ? new MatrixRoom(res?.[0].room_id) : null;
    }

    public async removeAdminRoom(room: MatrixRoom): Promise<void> {
        await this.sql`DELETE FROM admin_rooms WHERE room_id = ${room.roomId}`;
    }

    public async storeMatrixUser(matrixUser: MatrixUser): Promise<void> {
        const parameters = {
            user_id: matrixUser.getId(),
            data: JSON.stringify(matrixUser.serialize()),
        };
        await this.sql`INSERT INTO matrix_users ${this.sql(parameters)}
            ON CONFLICT (user_id)
            DO UPDATE SET data = ${parameters.data}`;
    }

    public async getIrcClientConfig(userId: string, domain: string): Promise<IrcClientConfig | null> {
        const res = await this.sql`SELECT config, password
        FROM client_config
        WHERE user_id = ${userId}
        AND domain = ${domain}`;
        if (!res?.length) {
            return null;
        }
        const [row] = res;
        const config = row.config || {}; // This may not be defined.
        if (row.password && this.cryptoStore) {
            config.password = this.cryptoStore.decrypt(row.password);
        }
        return new IrcClientConfig(userId, domain, config);
    }

    public async storeIrcClientConfig(config: IrcClientConfig): Promise<void> {
        const userId = config.getUserId();
        if (!userId) {
            throw Error("IrcClientConfig does not contain a userId");
        }
        log.debug(`Storing client configuration for ${userId}`);
        // We need to make sure we have a matrix user in the store.
        await this.sql`INSERT INTO matrix_users VALUES (${userId}, NULL) ON CONFLICT DO NOTHING`;
        let password = config.getPassword();
        if (password && this.cryptoStore) {
            password = this.cryptoStore.encrypt(password);
        }
        const parameters = {
            user_id: userId,
            domain: config.getDomain(),
            // either use the decrypted password, or whatever is stored already.
            password,
            config: JSON.stringify(config.serialize(true)),
        };
        await this.sql`INSERT INTO client_config ${this.sql(parameters)}
            ON CONSTRAINT cons_client_config_unique
            DO UPDATE SET ${this.sql(parameters)}`;
    }

    public async getMatrixUserByLocalpart(localpart: string): Promise<MatrixUser|null> {
        const userId = `@${localpart}:${this.bridgeDomain}`;
        const res = await this.sql`SELECT user_id, data FROM matrix_users WHERE user_id = ${userId}`;
        return res?.[0] ? new MatrixUser(res[0].user_id, res[0].data) : null;
    }

    public async getUserFeatures(userId: string): Promise<UserFeatures> {
        const existing = this.userFeatureCache.get(userId);
        if (existing) {
            return existing;
        }
        const pgRes = await this.sql`SELECT features FROM user_features WHERE user_id = ${userId}`;
        const features = (pgRes?.[0]?.features || {});
        this.userFeatureCache.set(userId, features);
        return features;
    }

    public async storeUserFeatures(userId: string, features: UserFeatures): Promise<void> {
        const parameters = {
            user_id: userId,
            features: JSON.stringify(features)
        };
        await this.sql`INSERT INTO user_features ${this.sql(parameters)}
            ON CONFLICT (user_id)
            DO UPDATE SET features = ${parameters.features}`;
    }

    public async getUserActivity(): Promise<UserActivitySet> {
        const res = await this.sql`SELECT * FROM user_activity`;
        const users: {[mxid: string]: UserActivity} = {};
        for (const row of res) {
            users[row['user_id']] = row['data'];
        }
        return { users };
    }

    public async storeUserActivity(userId: string, activity: UserActivity) {
        const data = JSON.stringify(activity);
        await this.sql`INSERT INTO user_activity ${this.sql({user_id: userId, data})}
        ON CONFLICT (user_id)
        DO UPDATE SET data = ${data}`;
    }

    public async storePass(userId: string, domain: string, pass: string, encrypt = true): Promise<void> {
        let password = pass;
        if (encrypt) {
            if (!this.cryptoStore) {
                throw Error("Password encryption is not configured.")
            }
            password = this.cryptoStore.encrypt(pass);
        }
        const parameters = {
            user_id: userId,
            domain,
            password,
        };
        await this.sql`INSERT INTO client_config ${this.sql(parameters)}
        ON CONSTRAINT cons_client_config_unique
        DO UPDATE SET password = ${password}`;
    }

    public async removePass(userId: string, domain: string): Promise<void> {
        await this.sql`UPDATE client_config SET password = NULL WHERE user_id = ${userId} AND domain = ${domain}`;
    }

    public async getMatrixUserByUsername(domain: string, username: string): Promise<MatrixUser|undefined> {
        // This will need a join
        const res = await this.sql`
            SELECT client_config.user_id, matrix_users.data
            FROM client_config, matrix_users
            WHERE config->>'username' = ${username}
            AND domain = ${domain}
            AND client_config.user_id = matrix_users.user_id
        `;
        if (res?.length === 0) {
            return undefined;
        }
        else if (res.length > 1) {
            log.error("getMatrixUserByUsername returned %s results for %s on %s", res.length, username, domain);
        }
        return new MatrixUser(res[0].user_id, res[0].data);
    }

    public async getCountForUsernamePrefix(domain: string, usernamePrefix: string): Promise<number> {
        const res = await this.sql<{count: number}[]>`SELECT COUNT(*)
        FROM client_config
        WHERE domain = ${domain}
        AND config->>'username' LIKE ${usernamePrefix} || '%'`;
        return res[0].count;
    }

    public async roomUpgradeOnRoomMigrated(oldRoomId: string, newRoomId: string) {
        await this.sql`UPDATE rooms SET room_id = ${newRoomId} WHERE room_id = ${oldRoomId}`;
    }

    public async updateLastSeenTimeForUser(userId: string) {
        const ts = Date.now();
        await this.sql`INSERT INTO last_seen ${this.sql({userId, ts})}
        ON CONFLICT (user_id)
        DO UPDATE SET ts = ${ts}`;
    }

    public async getLastSeenTimeForUsers(): Promise<{ user_id: string; ts: number }[]> {
        const res = await this.sql<{ user_id: string; ts: number }[]>`SELECT * FROM last_seen`;
        return res;
    }

    public async getAllUserIds() {
        const res = await this.sql`SELECT user_id FROM matrix_users`;
        return res.map((u) => u.user_id);
    }

    public async getRoomsVisibility(roomIds: string[]): Promise<Map<string, MatrixDirectoryVisibility>> {
        const map: Map<string, MatrixDirectoryVisibility> = new Map();
        const res = await this.sql<
            {room_id: string, visibility: MatrixDirectoryVisibility}[]
        >`SELECT room_id, visibility FROM room_visibility WHERE room_id IN ${roomIds}`;
        for (const row of res) {
            map.set(row.room_id, row.visibility ? "public" : "private");
        }
        return map;
    }

    public async setRoomVisibility(roomId: string, visibility: MatrixDirectoryVisibility) {
        await this.sql`INSERT INTO room_visibility ${this.sql({roomId, visibility})}
        ON CONFLICT (room_id)
        DO UPDATE SET visibility = ${visibility}`;
        log.info(`setRoomVisibility ${roomId} => ${visibility}`);
    }

    public async isUserDeactivated(userId: string): Promise<boolean> {
        const res = await this.sql`SELECT user_id FROM deactivated_users WHERE user_id = ${userId}`;
        return res?.length > 0;
    }

    public async deactivateUser(userId: string) {
        await this.sql`INSERT INTO deactivated_users VALUES (${userId}, ${Date.now()})`;
    }

    public async getRoomCount(): Promise<number> {
        const res = await this.sql<{count: number}[]>`SELECT COUNT(*) AS count FROM rooms`;
        return res?.[0].count;
    }
}
