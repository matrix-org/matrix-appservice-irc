/*
Copyright 2019 Huan LI
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
/**
 * This has been borrowed from https://github.com/huan/matrix-appservice-wechaty/blob/master/src/typings/matrix-appservice-bridge.d.ts
 * under the Apache2 licence.
 */
declare module 'matrix-appservice-bridge' {
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
        [id: string]: Array<Entry> ;
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

    export class PrometheusMetrics {
        addCollector(cb: () => void): void;
        addCounter(opts: { name: string; help: string; labels: string[]; }): import("prom-client").Counter
        addTimer(opts: { name: string; help: string; labels: string[]; }): import("prom-client").Histogram;
        addGauge(arg0: { name: string; help: string; labels: string[]; }): import("prom-client").Gauge;
    }

    class AgeCounters {
        constructor(buckets?: string[]);
        bump (ageInSec: number): void;
    }

    export class AppserviceBot {
        getJoinedMembers(roomId: string): {[userId: string]: {display_name: string|null}}
        isRemoteUser(userId: string): boolean;
        getJoinedRooms(): Promise<string[]>;
        getClient(): JsClient;
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
        select (query: any, transformFn?: (item: Entry) => Entry): Promise<any>
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

    export class ContentRepo {
        static getHttpUriForMxc(baseUrl: string, mxc: string): string;
    }

    export class Intent {
        leave(roomId: string): Promise<void>;
        setPowerLevel(roomId: string, userId: string, level: number | undefined): Promise<void>;
        getStateEvent(roomId: string, type: string): Promise<any>;
        getProfileInfo(userId: string, type?: "displayname"|"avatar_url", useCache?: boolean): Promise<{displayname: string|null, avatar_url: string|null}>;
        setPresence(presence: string): Promise<void>;
        sendMessage(roomId: string, content: any): Promise<void>;
        sendStateEvent(roomId: string, type: string, stateKey: string, content: any): Promise<void>;
        join(roomId: string): Promise<void>;
        kick(roomId: string, userId: string, reason: string): Promise<void>;
        setRoomTopic(roomId: string, topic: string): Promise<void>;
        readonly client: JsClient;
        getClient(): JsClient;
        setDisplayName(displayname: string): Promise<void>;
    }


    export class Request {
        outcomeFrom(the: Promise<unknown>): void;
        getData(): any;
        getDuration(): number;
        getPromise(): Promise<any>;
        getId(): string;
        resolve(item: unknown): void;
        reject(err: unknown): void;
    }

    export class JsClient {
        setRoomDirectoryVisibilityAppService(networkId: string, roomId: string, state: string): Promise<void>
        sendStateEvent(roomId: string, type: string, content: any, key: string): Promise<void>;
        credentials: {
            userId: string;
        };
        deleteAlias(alias: string): Promise<void>;
        roomState(roomId: string): Promise<any[]>;
        uploadContent(opts: {
            stream: Buffer
            name: string,
            type: string,
            rawResponse: boolean,
        }): Promise<void>;
    }

    export class Bridge {
        constructor(config: any);
        opts: {
            roomStore: RoomBridgeStore|undefined,
            userStore: UserBridgeStore|undefined,
        }
        getRoomStore(): RoomBridgeStore;
        getUserStore(): UserBridgeStore;
        getBot(): AppserviceBot;
        loadDatabases(): Promise<void>;
        getRequestFactory(): RequestFactory;
        getPrometheusMetrics(): PrometheusMetrics;
        getIntent(userId?: string): Intent;
        getIntentFromLocalpart(localpart: string): Intent;
        run(port: number): void;
        registerBridgeGauges(cb: () => void): void;
    }

    export class RequestFactory {
        newRequest(opts?: {data: {}}): Request;
        addDefaultResolveCallback(cb: (req: Request, result: string) => void): void;
        addDefaultRejectCallback(cb: (req: Request) => void): void;
        addDefaultTimeoutCallback(cb: (req: Request) => void, timeout: number): void;
    }

    export class AppServiceRegistration {
        static generateToken(): string;
        setSenderLocalpart(localpart: string): void;
        getSenderLocalpart(): string;
        setId(id: string): void;
        setHomeserverToken(token: string): void;
        setAppServiceToken(token: string): void;
        getAppServiceToken(): string;
        setRateLimited(limited: boolean): void;
        setProtocols(protocols: string[]): void;
        addRegexPattern(type: "rooms"|"aliases"|"users", regex: string, exclusive: boolean): void;
    }

    export class Logging {
        static configure(opts: {console: string}): void;
    }
}
