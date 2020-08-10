// /*
// Copyright 2019 Huan LI
// Copyright 2019,20 The Matrix.org Foundation C.I.C.

// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at

//  http://www.apache.org/licenses/LICENSE-2.0

// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// */
// /**
//  * This has been borrowed from https://github.com/huan/matrix-appservice-wechaty/blob/master/src/typings/matrix-appservice-bridge.d.ts
//  * under the Apache2 licence.
//  */

declare module 'matrix-appservice-bridge' {

    namespace PrometheusMetrics {
        class AgeCounters {
            constructor(buckets?: string[]);
            bump (ageInSec: number): void;
        }
    }

    interface RoomMemberDict {
        [id: string]: {
            display_name: string;
            avatar_url: string;
        };
    }
    interface RemoteRoomDict {
        [id: string]: RemoteRoom[];
    }
    interface EntryDict {
        [id: string]: Array<Entry>;
    }

    interface RoomCreationOpts {
        room_alias_name: string; // localpart
        name: string;
        visibility: "public"|"private";
        preset: "public_chat";
        creation_content?: {
            "m.federate"?: boolean;
        };
        initial_state: any[];
        room_version?: string;
    }

    export interface Entry {
        id: string;  // The unique ID for this entry.
        matrix_id: string;  // "room_id",
        remote_id: string;  // "remote_room_id",
        matrix: null|MatrixRoom; // <nullable> The matrix room, if applicable.
        remote: null|RemoteRoom; // <nullable> The remote room, if applicable.
        data: null|any; // <nullable> Information about this mapping, which may be an empty
    }

    export interface UpsertableEntry {
        id: string;  // The unique ID for this entry.
        matrix?: null|MatrixRoom; // <nullable> The matrix room, if applicable.
        remote?: null|RemoteRoom; // <nullable> The remote room, if applicable.
        data?: null|any; // <nullable> Information about this mapping, which may be an empty.
    }

    export class AppserviceBot {
        getJoinedMembers(roomId: string): {[userId: string]: {display_name: string|null}}
        isRemoteUser(userId: string): boolean;
        getJoinedRooms(): Promise<string[]>;
        getClient(): JsClient;
        //TODO:  _getRoomInfo is a private func and should be replaced.
        _getRoomInfo(roomId: string, data: any): any;
    }

    export class MatrixRoom {
        protected roomId: string;
        public name: string;
        public topic: string;
        public _extras : any;
        constructor (roomId: string, data?: object);
        deserialize(data: object): void;
        get(key: string): unknown;
        getId(): string;
        serialize(): object;
        set(key: string, val: any): void;
    }

    export class MatrixUser {
        public static ESCAPE_DEFAULT: boolean;
        public readonly localpart: string
        public readonly host: string

        userId: string

        constructor (userId: string, data?: object, escape?: boolean)
        escapeUserId(): void
        get(key: string): unknown
        getDisplayName(): null|string
        getId(): string
        serialize(): object
        set(key: string, val: any): void
        setDisplayName(name: string): void
    }

    export class RemoteRoom {
        constructor (identifier: string, data?: object)
        get(key: string): unknown
        getId(): string
        serialize(): object
        set(key: string, val: object|string|number): void
    }

    export class RemoteUser {
        constructor (id: string, data?: object)
        get(key: string): unknown
        getId(): string
        serialize(): object
        set(key: string, val: object|string|number): void
    }

    export class BridgeStore {
        db: Nedb
        delete (query: any): Promise<void>
        insert (query: any): Promise<void>
        select (query: any, transformFn?: (item: Entry) => any): Promise<any>
        inspect: () => string;
    }

    export class RoomBridgeStore extends BridgeStore {
        constructor(ds: Nedb);
        batchGetLinkedRemoteRooms (matrixIds: Array<string>): Promise<RemoteRoomDict>
        getEntriesByLinkData (data: object): Promise<Array<Entry>>
        getEntriesByMatrixId (matrixId: string): Promise<Array<Entry>>
        getEntriesByMatrixIds (ids: Array<string>): Promise<EntryDict>
        getEntriesByMatrixRoomData (data: object): Promise<Array<Entry>>
        getEntriesByRemoteId (remoteId: string): Promise<Array<Entry>>
        getEntriesByRemoteRoomData (data: object): Promise<Array<Entry>>
        getEntryById  (id: string): Promise<null|Entry>
        getLinkedMatrixRooms (remoteId: string): Promise<Array<MatrixRoom>>
        getLinkedRemoteRooms (matrixId: string): Promise<Array<RemoteRoom>>
        getMatrixRoom  (roomId: string): Promise<null|MatrixRoom>
        removeEntriesByLinkData (data: object): Promise<void>
        removeEntriesByMatrixRoomData (data: object): Promise<void>
        removeEntriesByMatrixRoomId (matrixId: string): Promise<void>
        removeEntriesByRemoteRoomData (data: object): Promise<void>
        removeEntriesByRemoteRoomId (remoteId: string): Promise<void>
        setMatrixRoom  (matrixRoom: MatrixRoom): Promise<void>
        upsertEntry  (entry: UpsertableEntry): Promise<void>
        linkRooms  (
            matrixRoom: MatrixRoom,
            remoteRoom: RemoteRoom,
            data?: object,
            linkId?: string,
        ): Promise<void>
    }

    export class UserBridgeStore extends BridgeStore {
        constructor(ds: Nedb);
        getByMatrixData (dataQuery: object): Promise<Array<MatrixUser>>
        getByMatrixLocalpart (localpart: string): Promise<null|MatrixUser>
        getByRemoteData (dataQuery: object): Promise<Array<RemoteUser>>
        getMatrixLinks (remoteId: string): Promise<Array<String>>
        getMatrixUser (userId: string): Promise<null|MatrixUser>
        getMatrixUsersFromRemoteId (remoteId: string): Promise<Array<MatrixUser>>
        getRemoteLinks (matrixId: string): Promise<Array<String>>
        getRemoteUser (id: string): Promise<null|RemoteUser>
        getRemoteUsersFromMatrixId (userId: string): Promise<Array<RemoteUser>>
        linkUsers  (matrixUser: MatrixUser, remoteUser: RemoteUser): Promise<void>
        setMatrixUser (matrixUser: MatrixUser): Promise<void>
        setRemoteUser (remoteUser: RemoteUser): Promise<void>
        unlinkUserIds (matrixUserId: string, remoteUserId: string): Promise<number>
        unlinkUsers (matrixUser: MatrixUser, remoteUser: RemoteUser): Promise<number>
    }

    export class JsClient {
        getStateEvent(roomId: string, type: string, skey?: string): Promise<any>;
        createAlias(roomAlias: string, roomId: string): Promise<void>;
        setRoomDirectoryVisibilityAppService(networkId: string, roomId: string, state: string): Promise<void>
        sendStateEvent(roomId: string, type: string, content: any, key: string): Promise<void>;
        credentials: {
            userId: string;
        };
        deleteAlias(alias: string): Promise<void>;
        roomState(roomId: string): Promise<any[]>;
        uploadContent(file: Buffer, opts: {
            name: string,
            type: string,
            rawResponse: boolean,
            onlyContentUri: boolean,
        }): Promise<string>;
        joinRoom(roomIdOrAlias: string): Promise<unknown>;
        leave(roomId: string): Promise<void>;
    }

    export class ConfigValidator {
        constructor(config: string|any);
        validate<T>(config: T, defaultConfig?: any): T;
    }

    export class Bridge {
        constructor(config: any);
        opts: {
            roomStore: RoomBridgeStore|undefined,
            userStore: UserBridgeStore|undefined,
        }
        appService: import("matrix-appservice").AppService;
        getRoomStore(): RoomBridgeStore;
        getUserStore(): UserBridgeStore;
        getBot(): AppserviceBot;
        loadDatabases(): Promise<void>;
        getRequestFactory(): import("matrix-appservice-bridge").RequestFactory;
        getPrometheusMetrics(registerEndpoint?: boolean, registry?: unknown): PrometheusMetrics;
        getIntent(userId?: string): import("matrix-appservice-bridge").Intent;
        getIntentFromLocalpart(localpart: string): import("matrix-appservice-bridge").Intent;
        requestCheckToken(req: Express.Request): boolean;
        run(port: number, config: undefined, appservice?: import("matrix-appservice").AppService, hostname?: string): void;
        registerBridgeGauges(cb: () => void): void;
        getClientFactory(): import("matrix-appservice-bridge").ClientFactory;
        canProvisionRoom(roomId: string): Promise<boolean>;
    }

    export class Logging {
        static configure(opts: {console: string}): void;
    }

    export class MembershipCache {
        constructor();
        setMemberEntry(roomId: string, userId: string, membership: "join"): void;
    }
}
