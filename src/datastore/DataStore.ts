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
    MatrixRoom, MatrixUser,
    RoomBridgeStoreEntry as Entry,
    UserActivity, UserActivitySet
} from "matrix-appservice-bridge";
import { IrcRoom } from "../models/IrcRoom";
import { IrcClientConfig } from "../models/IrcClientConfig";
import { IrcServer, IrcServerConfig } from "../irc/IrcServer";

export type RoomOrigin = "config"|"provision"|"alias"|"join";


export interface ChannelMappings {
    [roomId: string]: Array<{networkId: string; channel: string}>;
}

export interface UserFeatures {
    [name: string]: boolean|undefined;
}

export interface DataStore {
    setServerFromConfig(server: IrcServer, serverConfig: IrcServerConfig): Promise<void>;

    /**
     * Persists an IRC <--> Matrix room mapping in the database.
     * @param {IrcRoom} ircRoom : The IRC room to store.
     * @param {MatrixRoom} matrixRoom : The Matrix room to store.
     * @param {string} origin : "config" if this mapping is from the config yaml,
     * "provision" if this mapping was provisioned, "alias" if it was created via
     * aliasing and "join" if it was created during a join.
     * @return {Promise}
     */
    storeRoom(ircRoom: IrcRoom, matrixRoom: MatrixRoom, origin: RoomOrigin): Promise<void>;

    /**
     * Get an IRC <--> Matrix room mapping from the database.
     * @param {string} roomId : The Matrix room ID.
     * @param {string} ircDomain : The IRC server domain.
     * @param {string} ircChannel : The IRC channel.
     * @param {string} origin : (Optional) "config" if this mapping was from the config yaml,
     * "provision" if this mapping was provisioned, "alias" if it was created via aliasing and
     * "join" if it was created during a join.
     * @return {Promise} A promise which resolves to a room entry, or null if one is not found.
     */
    getRoom(roomId: string, ircDomain: string, ircChannel: string, origin?: RoomOrigin): Promise<Entry|null>;

    /**
     * Get all Matrix <--> IRC room mappings from the database.
     * @return {Promise} A promise which resolves to a map:
     *      $roomId => [{networkId: 'server #channel1', channel: '#channel2'} , ...]
     */
    getAllChannelMappings(): Promise<ChannelMappings>;

    /**
     * Get provisioned IRC <--> Matrix room mappings from the database where
     * the matrix room ID is roomId.
     * @param {string} roomId : The Matrix room ID.
     * @return {Promise} A promise which resolves to a list
     * of entries.
     */
    getProvisionedMappings(roomId: string): Promise<Entry[]>;

    /**
     * Remove an IRC <--> Matrix room mapping from the database.
     * @param {string} roomId : The Matrix room ID.
     * @param {string} ircDomain : The IRC server domain.
     * @param {string} ircChannel : The IRC channel.
     * @param {string} origin : "config" if this mapping was from the config yaml,
     * "provision" if this mapping was provisioned, "alias" if it was created via
     * aliasing and "join" if it was created during a join.
     * @return {Promise}
     */
    removeRoom(roomId: string, ircDomain: string, ircChannel: string, origin?: RoomOrigin): Promise<void>;

    /**
     * Retrieve a list of IRC rooms for a given room ID.
     * @param {string} roomId : The room ID to get mapped IRC channels.
     * @return {Promise<Array<IrcRoom>>} A promise which resolves to a list of
     * rooms.
     */
    getIrcChannelsForRoomId(roomId: string): Promise<IrcRoom[]>;


    /**
     * Retrieve a list of IRC rooms for a given list of room IDs. This is significantly
     * faster than calling getIrcChannelsForRoomId for each room ID.
     * @param {string[]} roomIds : The room IDs to get mapped IRC channels.
     * @return {Promise<Map<string, IrcRoom[]>>} A promise which resolves to a map of
     * room ID to an array of IRC rooms.
     */
    getIrcChannelsForRoomIds(roomIds: string[]): Promise<{[roomId: string]: IrcRoom[]}>;

    /**
     * Retrieve a list of Matrix rooms for a given server and channel.
     * @param {IrcServer} server : The server to get rooms for.
     * @param {string} channel : The channel to get mapped rooms for.
     * @return {Promise<Array<MatrixRoom>>} A promise which resolves to a list of rooms.
     */
    getMatrixRoomsForChannel(server: IrcServer, channel: string): Promise<Array<MatrixRoom>>;

    getMappingsForChannelByOrigin(server: IrcServer, channel: string,
                                  origin: RoomOrigin|RoomOrigin[], allowUnset: boolean): Promise<Entry[]>;

    getModesForChannel (server: IrcServer, channel: string): Promise<{[id: string]: string[]}>;

    setModeForRoom(roomId: string, mode: string, enabled: boolean): Promise<void>;

    setPmRoom(ircRoom: IrcRoom, matrixRoom: MatrixRoom, userId: string, virtualUserId: string): Promise<void>;

    removePmRoom(roomId: string): Promise<void>;

    getMatrixPmRoom(realUserId: string, virtualUserId: string): Promise<MatrixRoom|null>;

    getMatrixPmRoomById(roomId: string): Promise<MatrixRoom|null>;

    getTrackedChannelsForServer(domain: string): Promise<string[]>;

    getRoomIdsFromConfig(): Promise<string[]>;

    removeConfigMappings(): Promise<void>;

    getIpv6Counter(server: IrcServer, homeserver: string|null): Promise<number>;

    setIpv6Counter(counter: number, server: IrcServer, homeserver: string|null): Promise<void>;

    getAdminRoomById(roomId: string): Promise<MatrixRoom|null>;

    storeAdminRoom(room: MatrixRoom, userId: string): Promise<void>;

    removeAdminRoom(room: MatrixRoom): Promise<void>;

    upsertMatrixRoom(room: MatrixRoom): Promise<void>;

    getAdminRoomByUserId(userId: string): Promise<MatrixRoom|null>;

    storeMatrixUser(matrixUser: MatrixUser): Promise<void>;

    getIrcClientConfig(userId: string, domain: string): Promise<IrcClientConfig|null>;

    storeIrcClientConfig(config: IrcClientConfig): Promise<void>;

    getMatrixUserByLocalpart(localpart: string): Promise<MatrixUser|null>;

    getUserFeatures(userId: string): Promise<UserFeatures>;

    storeUserFeatures(userId: string, features: UserFeatures): Promise<void>;

    getUserActivity(): Promise<UserActivitySet>;

    storeUserActivity(userId: string, activity: UserActivity): Promise<void>;

    storePass(userId: string, domain: string, pass: string): Promise<void>;

    removePass(userId: string, domain: string): Promise<void>;

    getMatrixUserByUsername(domain: string, username: string): Promise<MatrixUser|undefined>;

    getCountForUsernamePrefix(domain: string, usernamePrefix: string): Promise<number>;

    roomUpgradeOnRoomMigrated(oldRoomId: string, newRoomId: string): Promise<void>;

    updateLastSeenTimeForUser(userId: string): Promise<void>;

    getLastSeenTimeForUsers(): Promise<{ user_id: string; ts: number }[]>;

    getAllUserIds(): Promise<string[]>;

    getRoomsVisibility(roomIds: string[]): Promise<{[roomId: string]: "public"|"private"}>;

    setRoomVisibility(roomId: string, vis: "public"|"private"): Promise<void>;

    isUserDeactivated(userId: string): Promise<boolean>;

    deactivateUser(userId: string): Promise<void>;

    getRoomCount(): Promise<number>;

    destroy(): Promise<void>;
}
