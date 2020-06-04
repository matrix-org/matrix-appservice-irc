import Bluebird from "bluebird";
import extend from "extend";
import * as promiseutil from "../promiseutil";
import { IrcHandler } from "./IrcHandler";
import { MatrixHandler } from "./MatrixHandler";
import { MemberListSyncer } from "./MemberListSyncer";
import { IrcServer } from "../irc/IrcServer";
import { ClientPool } from "../irc/ClientPool";
import { BridgedClient } from "../irc/BridgedClient";
import { IrcUser } from "../models/IrcUser";
import { IrcRoom } from "../models/IrcRoom";
import { BridgeRequest, BridgeRequestErr } from "../models/BridgeRequest";
import { NeDBDataStore } from "../datastore/NedbDataStore";
import { PgDataStore } from "../datastore/postgres/PgDataStore";
import { getLogger } from "../logging";
import { DebugApi } from "../DebugApi";
import { MatrixActivityTracker } from "matrix-lastactive";
import { Provisioner } from "../provisioning/Provisioner.js";
import { PublicitySyncer } from "./PublicitySyncer";
import { Histogram } from "prom-client";
import { AppServiceRegistration, AppService } from "matrix-appservice";

import {
    Bridge,
    MatrixUser,
    MatrixRoom,
    Logging,
    Request,
    PrometheusMetrics,
    MembershipCache,
} from "matrix-appservice-bridge";
import { IrcAction } from "../models/IrcAction";
import { DataStore } from "../datastore/DataStore";
import { MatrixAction } from "../models/MatrixAction";
import { BridgeConfig } from "../config/BridgeConfig";
import { MembershipQueue } from "../util/MembershipQueue";
import { BridgeStateSyncer } from "./BridgeStateSyncer";

const log = getLogger("IrcBridge");
const DEFAULT_PORT = 8090;
const DELAY_TIME_MS = 10 * 1000;
const DELAY_FETCH_ROOM_LIST_MS = 3 * 1000;
const DEAD_TIME_MS = 5 * 60 * 1000;
const TXN_SIZE_DEFAULT = 10000000 // 10MB

export class IrcBridge {
    public static readonly DEFAULT_LOCALPART = "appservice-irc";
    public onAliasQueried: (() => void)|null = null;
    public readonly matrixHandler: MatrixHandler;
    public readonly ircHandler: IrcHandler;
    public readonly publicitySyncer: PublicitySyncer;
    private clientPool!: ClientPool; // This gets defined in the `run` function
    private ircServers: IrcServer[] = [];
    private memberListSyncers: {[domain: string]: MemberListSyncer} = {};
    private joinedRoomList: string[] = [];
    private activityTracker: MatrixActivityTracker|null = null;
    private dataStore!: DataStore;
    private startedUp = false;
    private debugApi: DebugApi|null = null;
    private provisioner: Provisioner|null = null;
    private bridge: Bridge;
    private appservice: AppService;
    private timers: {
        matrix_request_seconds: Histogram;
        remote_request_seconds: Histogram;
    }|null = null;
    private membershipCache: MembershipCache;
    private readonly membershipQueue: MembershipQueue;
    private bridgeStateSyncer!: BridgeStateSyncer;

    constructor(public readonly config: BridgeConfig, private registration: AppServiceRegistration) {
        // TODO: Don't log this to stdout
        Logging.configure({console: config.ircService.logging.level});
        if (config.ircService.debugApi && config.ircService.debugApi.enabled) {
            this.activityTracker = new MatrixActivityTracker({
                homeserverUrl: this.config.homeserver.url,
                accessToken: registration.getAppServiceToken() as string,
                usePresence: this.config.homeserver.enablePresence,
                serverName: this.config.homeserver.domain,
                logger: getLogger("MxActivityTracker"),
                defaultOnline: true,
            });
        }
        if (!this.config.database && this.config.ircService.databaseUri) {
            log.warn("ircService.databaseUri is a deprecated config option." +
                     "Please use the database configuration block");
            this.config.database = {
                engine: "nedb",
                connectionString: this.config.ircService.databaseUri,
            }
        }
        let roomLinkValidation = undefined;
        const provisioning = config.ircService.provisioning;
        if (provisioning && provisioning.enabled &&
            typeof (provisioning.ruleFile) === "string") {
            roomLinkValidation = {
                ruleFile: provisioning.ruleFile,
                triggerEndpoint: provisioning.enableReload
            };
        }
        let bridgeStoreConfig = {};

        if (this.config.database.engine === "nedb") {
            const dirPath = this.config.database.connectionString.substring("nedb://".length);
            bridgeStoreConfig = {
                roomStore: `${dirPath}/rooms.db`,
                userStore: `${dirPath}/users.db`,
            };
        }
        this.membershipCache = new MembershipCache();
        this.bridge = new Bridge({
            registration: this.registration,
            homeserverUrl: this.config.homeserver.url,
            domain: this.config.homeserver.domain,
            controller: {
                onEvent: this.onEvent.bind(this),
                onUserQuery: this.onUserQuery.bind(this),
                onAliasQuery: this.onAliasQuery.bind(this),
                onAliasQueried: this.onAliasQueried ?
                    this.onAliasQueried.bind(this) : null,
                onLog: this.onLog.bind(this),

                thirdPartyLookup: {
                    protocols: ["irc"],
                    getProtocol: this.getThirdPartyProtocol.bind(this),
                    getLocation: this.getThirdPartyLocation.bind(this),
                    getUser: this.getThirdPartyUser.bind(this),
                },
            },
            ...bridgeStoreConfig,
            disableContext: true,
            suppressEcho: false, // we use our own dupe suppress for now
            logRequestOutcome: false, // we use our own which has better logging
            queue: {
                type: "none",
                perRequest: false
            },
            intentOptions: {
                clients: {
                    dontCheckPowerLevel: true,
                    enablePresence: this.config.homeserver.enablePresence,
                },
                bot: {
                    dontCheckPowerLevel: true,
                    enablePresence: this.config.homeserver.enablePresence,
                }
            },
            // See note below for ESCAPE_DEFAULT
            escapeUserIds: false,
            roomLinkValidation,
            roomUpgradeOpts: {
                consumeEvent: true,
                migrateGhosts: false,
                onRoomMigrated: this.onRoomUpgrade.bind(this),
                migrateStoreEntries: false, // Only NeDB supports this.
            },
            membershipCache: this.membershipCache,
            migrateStoreEntries: false,
        });
        this.membershipQueue = new MembershipQueue(this.bridge);
        this.matrixHandler = new MatrixHandler(this, this.config.matrixHandler || {}, this.membershipQueue);
        this.ircHandler = new IrcHandler(this, this.config.ircHandler, this.membershipQueue);

        // By default the bridge will escape mxids, but the irc bridge isn't ready for this yet.
        MatrixUser.ESCAPE_DEFAULT = false;

        if (this.config.ircService.metrics && this.config.ircService.metrics.enabled) {
            this.initialiseMetrics();
        }
        this.publicitySyncer = new PublicitySyncer(this);

        const homeserverToken = this.registration.getHomeserverToken();
        if (!homeserverToken) {
            throw Error("No HS token defined");
        }

        this.appservice = new AppService({
            homeserverToken,
            httpMaxSizeBytes: (this.config.advanced || { }).maxTxnSize || TXN_SIZE_DEFAULT,
        });

    }

    private initialiseMetrics() {
        const zeroAge = new PrometheusMetrics.AgeCounters();

        const metrics = this.bridge.getPrometheusMetrics();

        this.bridge.registerBridgeGauges(() => {
            const remoteUsersByAge = new PrometheusMetrics.AgeCounters(
                this.config.ircService.metrics.remoteUserAgeBuckets || ["1h", "1d", "1w"]
            );

            this.ircServers.forEach((server) => {
                this.clientPool.updateActiveConnectionMetrics(server.domain, remoteUsersByAge);
            });

            return {
                // TODO(paul): actually fill these in
                matrixRoomConfigs: 0,
                remoteRoomConfigs: 0,

                remoteGhosts: this.clientPool.countTotalConnections(),
                // matrixGhosts is provided automatically by the bridge

                // TODO(paul) IRC bridge doesn't maintain mtimes at the moment.
                //   Should probably make these metrics optional to most
                //   exporters
                matrixRoomsByAge: zeroAge,
                remoteRoomsByAge: zeroAge,

                matrixUsersByAge: zeroAge,
                remoteUsersByAge,
            };
        });

        this.timers = {
            matrix_request_seconds: metrics.addTimer({
                name: "matrix_request_seconds",
                help: "Histogram of processing durations of received Matrix messages",
                labels: ["outcome"],
            }),
            remote_request_seconds: metrics.addTimer({
                name: "remote_request_seconds",
                help: "Histogram of processing durations of received remote messages",
                labels: ["outcome"],
            })
        };

        // Custom IRC metrics
        const reconnQueue = metrics.addGauge({
            name: "clientpool_reconnect_queue",
            help: "Number of disconnected irc connections waiting to reconnect.",
            labels: ["server"]
        });

        const memberListLeaveQueue = metrics.addGauge({
            name: "user_leave_queue",
            help: "Number of leave requests queued up for virtual users on the bridge.",
            labels: ["server"]
        });

        const memberListJoinQueue = metrics.addGauge({
            name: "user_join_queue",
            help: "Number of join requests queued up for virtual users on the bridge.",
            labels: ["server"]
        });

        const ircHandlerCalls = metrics.addCounter({
            name: "irchandler_calls",
            help: "Track calls made to the IRC Handler",
            labels: ["method"]
        });

        const matrixHandlerConnFailureKicks = metrics.addCounter({
            name: "matrixhandler_connection_failure_kicks",
            help: "Track IRC connection failures resulting in kicks",
            labels: ["server"]
        });

        metrics.addCollector(() => {
            this.ircServers.forEach((server) => {
                reconnQueue.set({server: server.domain},
                    this.clientPool.totalReconnectsWaiting(server.domain)
                );
                const mxMetrics = this.matrixHandler.getMetrics(server.domain);
                matrixHandlerConnFailureKicks.inc(
                    {server: server.domain},
                    mxMetrics["connection_failure_kicks"] || 0
                );
            });

            Object.keys(this.memberListSyncers).forEach((server) => {
                memberListLeaveQueue.set(
                    {server},
                    this.memberListSyncers[server].getUsersWaitingToLeave()
                );
                memberListJoinQueue.set(
                    {server},
                    this.memberListSyncers[server].getUsersWaitingToJoin()
                );
            });

            const ircMetrics = this.ircHandler.getMetrics();
            Object.entries(ircMetrics).forEach((kv) => {
                ircHandlerCalls.inc({method: kv[0]}, kv[1]);
            });
        });
    }

    public get appServiceUserId() {
        return `@${this.registration.getSenderLocalpart()}:${this.domain}`;
    }

    public getStore() {
        return this.dataStore;
    }

    public getAppServiceBridge() {
        return this.bridge;
    }

    public getClientPool() {
        return this.clientPool;
    }

    public getProvisioner(): Provisioner {
        return this.provisioner as Provisioner;
    }

    public get domain() {
        return this.config.homeserver.domain;
    }

    public get stateSyncer() {
        return this.bridgeStateSyncer;
    }

    public async run(port: number|null) {
        const dbConfig = this.config.database;
        // cli port, then config port, then default port
        port = port || this.config.homeserver.bindPort || DEFAULT_PORT;
        const pkeyPath = this.config.ircService.passwordEncryptionKeyPath;

        if (dbConfig.engine === "postgres") {
            log.info("Using PgDataStore for Datastore");
            const pgDs = new PgDataStore(this.config.homeserver.domain, dbConfig.connectionString, pkeyPath);
            await pgDs.ensureSchema();
            this.dataStore = pgDs;
        }
        else if (dbConfig.engine === "nedb") {
            await this.bridge.loadDatabases();
            log.info("Using NeDBDataStore for Datastore");
            this.dataStore = new NeDBDataStore(
                this.bridge.getUserStore(),
                this.bridge.getRoomStore(),
                this.config.homeserver.domain,
                pkeyPath,
            );
        }
        else {
            throw Error("Incorrect database config");
        }

        await this.dataStore.removeConfigMappings();

        this.clientPool = new ClientPool(this, this.dataStore);

        if (this.config.ircService.debugApi.enabled) {
            this.debugApi = new DebugApi(
                this,
                this.config.ircService.debugApi.port,
                this.ircServers,
                this.clientPool,
                this.registration.getAppServiceToken() as string
            );
            if (this.dataStore instanceof NeDBDataStore) {
                // monkey patch inspect() values to avoid useless NeDB
                // struct spam on the debug API.
                this.bridge.getUserStore().inspect = () => "UserStore";
                this.bridge.getRoomStore().inspect = () => "RoomStore";
            }
            this.debugApi.run();
        }

        if (this.activityTracker) {
            log.info("Restoring last active times from DB");
            const users = await this.dataStore.getLastSeenTimeForUsers();
            for (const user of users) {
                this.activityTracker.setLastActiveTime(user.user_id, user.ts);
            }
            log.info(`Restored ${users.length} last active times from DB`);
        }

        // maintain a list of IRC servers in-use
        const serverDomains = Object.keys(this.config.ircService.servers);
        for (let i = 0; i < serverDomains.length; i++) {
            const domain = serverDomains[i];
            const completeConfig = extend(
                true, {}, IrcServer.DEFAULT_CONFIG, this.config.ircService.servers[domain]
            );
            const server = new IrcServer(
                domain, completeConfig, this.config.homeserver.domain,
                this.config.homeserver.dropMatrixMessagesAfterSecs
            );
            // store the config mappings in the DB to keep everything in one place.
            await this.dataStore.setServerFromConfig(server, completeConfig);
            this.ircServers.push(server);
        }

        if (this.ircServers.length === 0) {
            throw Error("No IRC servers specified.");
        }

        // run the bridge (needs to be done prior to configure IRC side)
        await this.bridge.run(port, undefined, this.appservice, this.config.homeserver.bindHostname);

        this.addRequestCallbacks();
        if (!this.registration.getSenderLocalpart() ||
                !this.registration.getAppServiceToken()) {
            throw Error(
                "FATAL: Registration file is missing a sender_localpart and/or AS token."
            );
        }

        // Storing all the users we know about to avoid calling /register on them.
        const allUsers = await this.dataStore.getAllUserIds();
        const bot = this.bridge.getBot();
        allUsers.filter((u) => bot.isRemoteUser(u))
            .forEach((u) => this.membershipCache.setMemberEntry("", u, "join"));


        log.info("Fetching Matrix rooms that are already joined to...");
        await this.fetchJoinedRooms();

        for (const roomId of this.joinedRoomList) {
            this.membershipCache.setMemberEntry(roomId, this.appServiceUserId, "join");
        }

        if (this.config.ircService.bridgeInfoState?.enabled) {
            this.bridgeStateSyncer = new BridgeStateSyncer(this.dataStore, this.bridge, this);
            if (this.config.ircService.bridgeInfoState.initial) {
                this.bridgeStateSyncer.beginSync().then(() => {
                    log.info("Bridge state syncing completed");
                }).catch((err) => {
                    log.error("Bridge state syncing resulted in an error:", err);
                });
            }
        }

        log.info("Joining mapped Matrix rooms...");
        await this.joinMappedMatrixRooms();
        log.info("Syncing relevant membership lists...");
        const memberlistPromises: Promise<void>[] = [];

        // HACK: Remember reconnectIntervals to put them back later
        //  If memberlist-syncing 100s of connections, the scheduler will cause massive
        //  waiting times for connections to be created.
        //  We disable this scheduling manually to allow people to send messages through
        //  quickly when starting up (effectively prioritising them). This is just the
        //  quickest way to disable scheduler.
        const reconnectIntervalsMap = Object.create(null);

        this.ircServers.forEach((server) => {

            reconnectIntervalsMap[server.domain] = server.getReconnectIntervalMs();
            server.config.ircClients.reconnectIntervalMs = 0;

            // TODO reduce deps required to make MemberListSyncers.
            // TODO Remove injectJoinFn bodge
            this.memberListSyncers[server.domain] = new MemberListSyncer(
                this, this.bridge.getBot(), server, this.appServiceUserId,
                (roomId: string, joiningUserId: string, displayName: string, isFrontier: boolean) => {
                    const req = new BridgeRequest(
                        this.bridge.getRequestFactory().newRequest()
                    );
                    const target = new MatrixUser(joiningUserId);
                    // inject a fake join event which will do M->I connections and
                    // therefore sync the member list
                    return this.matrixHandler.onJoin(req, {
                        room_id: roomId,
                        content: {
                            displayname: displayName,
                        },
                        _injected: true,
                        _frontier: isFrontier
                    }, target);
                }
            );
            memberlistPromises.push(
                this.memberListSyncers[server.domain].sync()
            );
        });

        const provisioningEnabled = this.config.ircService.provisioning.enabled;
        const requestTimeoutSeconds = this.config.ircService.provisioning.requestTimeoutSeconds;
        this.provisioner = new Provisioner(this, provisioningEnabled, requestTimeoutSeconds);

        log.info("Connecting to IRC networks...");
        await this.connectToIrcNetworks();

        promiseutil.allSettled(this.ircServers.map((server) => {
            // Call MODE on all known channels to get modes of all channels
            return Bluebird.cast(this.publicitySyncer.initModes(server));
        })).catch((err) => {
            log.error('Could not init modes for publicity syncer');
            log.error(err.stack);
        });

        await Bluebird.all(memberlistPromises);

        // Reset reconnectIntervals
        this.ircServers.forEach((server) => {
            server.config.ircClients.reconnectIntervalMs = reconnectIntervalsMap[server.domain];
        });

        log.info("Startup complete.");
        this.startedUp = true;
    }

    private logMetric(req: Request, outcome: string) {
        if (!this.timers) {
            return; // metrics are disabled
        }
        const isFromIrc = Boolean((req.getData() || {}).isFromIrc);
        const timer = this.timers[
            isFromIrc ? "remote_request_seconds" : "matrix_request_seconds"
        ];
        if (timer) {
            timer.observe({outcome}, req.getDuration() / 1000);
        }
    }

    private addRequestCallbacks() {
        function logMessage(req: Request, msg: string) {
            const data = req.getData();
            const dir = data && data.isFromIrc ? "I->M" : "M->I";
            const duration = " (" + req.getDuration() + "ms)";
            log.info(`[${req.getId()}] [${dir}] ${msg} ${duration}`);
        }

        // SUCCESS
        this.bridge.getRequestFactory().addDefaultResolveCallback((req, _res) => {
            const res = _res as BridgeRequestErr|null;
            if (res === BridgeRequestErr.ERR_VIRTUAL_USER) {
                logMessage(req, "IGNORE virtual user");
                return; // these aren't true successes so don't skew graphs
            }
            else if (res === BridgeRequestErr.ERR_NOT_MAPPED) {
                logMessage(req, "IGNORE not mapped");
                return; // these aren't true successes so don't skew graphs
            }
            else if (res === BridgeRequestErr.ERR_DROPPED) {
                logMessage(req, "IGNORE dropped");
                this.logMetric(req, "dropped");
                return;
            }
            logMessage(req, "SUCCESS");
            this.logMetric(req, "success");
        });
        // FAILURE
        this.bridge.getRequestFactory().addDefaultRejectCallback((req) => {
            logMessage(req, "FAILED");
            this.logMetric(req, "fail");
            BridgeRequest.HandleExceptionForSentry(req, "fail");
        });
        // DELAYED
        this.bridge.getRequestFactory().addDefaultTimeoutCallback((req) => {
            logMessage(req, "DELAYED");
        }, DELAY_TIME_MS);
        // DEAD
        this.bridge.getRequestFactory().addDefaultTimeoutCallback((req) => {
            logMessage(req, "DEAD");
            this.logMetric(req, "dead");
            BridgeRequest.HandleExceptionForSentry(req, "dead");
        }, DEAD_TIME_MS);
    }

    // Kill the bridge by killing all IRC clients in memory.
    //  Killing a client means that it will disconnect forever
    //  and never do anything useful again.
    //  There is no guarentee that the bridge will do anything
    //  usefull once this has been called.
    //
    //  See (BridgedClient.prototype.kill)
    public async kill() {
        log.info("Killing all clients");
        await this.clientPool.killAllClients();
        if (this.dataStore) {
            await this.dataStore.destroy();
        }
    }

    public get isStartedUp() {
        return this.startedUp;
    }

    private async joinMappedMatrixRooms() {
        const roomIds = await this.getStore().getRoomIdsFromConfig();
        const promises = roomIds.map(async (roomId) => {
            if (this.joinedRoomList.includes(roomId)) {
                log.debug(`Not joining ${roomId} because we are marked as joined`);
                return;
            }
            await this.bridge.getIntent().join(roomId);
        }).map(Bluebird.cast);
        await promiseutil.allSettled(promises);
    }

    public async sendMatrixAction(room: MatrixRoom, from: MatrixUser, action: MatrixAction): Promise<void> {
        const intent = this.bridge.getIntent(from.userId);
        if (action.msgType) {
            if (action.htmlText) {
                await intent.sendMessage(room.getId(), {
                    msgtype: action.msgType,
                    body: (
                        action.text || action.htmlText.replace(/(<([^>]+)>)/ig, "") // strip html tags
                    ),
                    format: "org.matrix.custom.html",
                    formatted_body: action.htmlText
                });
            }
            else {
                await intent.sendMessage(room.getId(), {
                    msgtype: action.msgType,
                    body: action.text
                });
            }
            return;
        }
        else if (action.type === "topic" && action.text) {
            await intent.setRoomTopic(room.getId(), action.text);
            return;
        }
        throw Error("Unknown action: " + action.type);
    }

    public uploadTextFile(fileName: string, plaintext: string) {
        return this.bridge.getIntent().getClient().uploadContent(
            Buffer.from(plaintext),
            {
                name: fileName,
                type: "text/plain; charset=utf-8",
                rawResponse: false,
                onlyContentUri: true,
            },
        );
    }

    public async getMatrixUser(ircUser: IrcUser) {
        let matrixUser = null;
        const userLocalpart = ircUser.server.getUserLocalpart(ircUser.nick);
        const displayName = ircUser.server.getDisplayNameFromNick(ircUser.nick);

        try {
            matrixUser = await this.getStore().getMatrixUserByLocalpart(userLocalpart);
            if (matrixUser) {
                return matrixUser;
            }
        }
        catch (e) {
            // user does not exist. Fall through.
        }

        log.info(`${userLocalpart} does not exist in the store yet, setting a profile`);

        const userIntent = this.bridge.getIntentFromLocalpart(userLocalpart);
        await userIntent.setDisplayName(displayName); // will also register this user
        matrixUser = new MatrixUser(userIntent.getClient().credentials.userId);
        matrixUser.setDisplayName(displayName);
        await this.getStore().storeMatrixUser(matrixUser);
        return matrixUser;
    }

    public onEvent(request: Request) {
        request.outcomeFrom(this._onEvent(request));
    }

    private async _onEvent (baseRequest: Request): Promise<BridgeRequestErr|undefined> {
        const event = baseRequest.getData();
        let updatePromise: Promise<void>|null = null;
        if (event.sender && this.activityTracker) {
            updatePromise = this.dataStore.updateLastSeenTimeForUser(event.sender);
            this.activityTracker.bumpLastActiveTime(event.sender);
        }
        const request = new BridgeRequest(baseRequest);
        if (event.type === "m.room.message") {
            if (event.origin_server_ts && this.config.homeserver.dropMatrixMessagesAfterSecs) {
                const now = Date.now();
                if ((now - event.origin_server_ts) >
                        (1000 * this.config.homeserver.dropMatrixMessagesAfterSecs)) {
                    log.info(
                        "Dropping old m.room.message event %s timestamped %d",
                        event.event_id, event.origin_server_ts
                    );
                    return BridgeRequestErr.ERR_DROPPED;
                }
            }
            await this.matrixHandler.onMessage(request, event);
        }
        else if (event.type === "m.room.topic" && event.state_key === "") {
            await this.matrixHandler.onMessage(request, event);
        }
        else if (event.type === "m.room.member") {
            if (!event.content || !event.content.membership) {
                return BridgeRequestErr.ERR_NOT_MAPPED;
            }
            this.ircHandler.onMatrixMemberEvent(event);
            const target = new MatrixUser(event.state_key);
            const sender = new MatrixUser(event.sender);
            if (event.content.membership === "invite") {
                await this.matrixHandler.onInvite(request, event, sender, target);
            }
            else if (event.content.membership === "join") {
                await this.matrixHandler.onJoin(request, event, target);
            }
            else if (["ban", "leave"].indexOf(event.content.membership) !== -1) {
                // Given a "self-kick" is a leave, and you can't ban yourself,
                // if the 2 IDs are different then we know it is either a kick
                // or a ban (or a rescinded invite)
                const isKickOrBan = target.getId() !== sender.getId();
                if (isKickOrBan) {
                    await this.matrixHandler.onKick(request, event, sender, target);
                }
                else {
                    await this.matrixHandler.onLeave(request, event, target);
                }
            }
        }
        else if (event.type === "m.room.power_levels" && event.state_key === "") {
            this.ircHandler.roomAccessSyncer.onMatrixPowerlevelEvent(event);
        }
        try {
            // Await this *after* handling the event.
            await updatePromise;
        }
        catch (ex) {
            log.debug("Could not update last seen time for user: %s", ex);
        }
        return undefined;
    }

    public async onUserQuery(matrixUser: MatrixUser) {
        const baseRequest = this.bridge.getRequestFactory().newRequest();
        const request = new BridgeRequest(baseRequest);
        await this.matrixHandler.onUserQuery(request, matrixUser.getId());
        // TODO: Lean on the bridge lib more
        return null; // don't provision, we already do atm
    }

    public async onAliasQuery (alias: string) {
        const baseRequest = this.bridge.getRequestFactory().newRequest();
        const request = new BridgeRequest(baseRequest);
        await this.matrixHandler.onAliasQuery(request, alias);
        // TODO: Lean on the bridge lib more
        return null; // don't provision, we already do atm
    }

    private onLog(line: string, isError: boolean) {
        if (isError) {
            log.error(line);
        }
        else {
            log.info(line);
        }
    }

    public getThirdPartyProtocol() {
        const servers = this.getServers();

        return Bluebird.resolve({
            user_fields: ["domain", "nick"],
            location_fields: ["domain", "channel"],
            field_types: {
                domain: {
                    regexp: "[a-z0-9-_]+(\.[a-z0-9-_]+)*",
                    placeholder: "irc.example.com",
                },
                nick: {
                    regexp: "[^#\\s]+",
                    placeholder: "SomeNick",
                },
                channel: {
                    // TODO(paul): Declare & and + in this list sometime when the
                    //   bridge can support them
                    regexp: "[#][^\\s]+",
                    placeholder: "#channel",
                },
            },
            instances: servers.map((server: IrcServer) => {
                return {
                    network_id: server.getNetworkId(),
                    bot_user_id: this.appServiceUserId,
                    desc: server.config.name || server.domain,
                    icon: server.config.icon,
                    fields: {
                        domain: server.domain,
                    },
                };
            }),
        });
    }

    public async getThirdPartyLocation(protocol: string, fields: {domain?: string; channel?: string}) {
        if (!fields.domain) {
            throw {err: "Expected 'domain' field", code: 400};
        }
        const domain = fields.domain.toLowerCase();

        if (!fields.channel) {
            throw {err: "Expected 'channel' field", code: 400};
        }
        // TODO(paul): this ought to use IRC network-specific casefolding (e.g. rfc1459)
        const channel = fields.channel.toLowerCase();

        const server = this.getServer(domain);
        if (!server) {
            return [];
        }

        if (!server.config.dynamicChannels.enabled) {
            return [];
        }

        const alias = server.getAliasFromChannel(channel);

        return [
            {
                alias: alias,
                protocol: "irc",
                fields: {
                    domain: domain,
                    channel: channel,
                }
            }
        ];
    }

    public async getThirdPartyUser(protocol: string, fields: {domain?: string; nick?: string}) {
        if (!fields.domain) {
            throw {err: "Expected 'domain' field", code: 400};
        }
        const domain = fields.domain.toLowerCase();

        if (!fields.nick) {
            throw {err: "Expected 'nick' field", code: 400};
        }
        // TODO(paul): this ought to use IRC network-specific casefolding (e.g. rfc1459)
        const nick = fields.nick.toLowerCase();

        const server = this.getServer(domain);
        if (!server) {
            return [];
        }

        const userId = server.getUserIdFromNick(nick);

        return [
            {
                userid: userId,
                protocol: "irc",
                fields: {
                    domain: domain,
                    nick: nick,
                }
            }
        ];
    }

    public getIrcUserFromCache(server: IrcServer, userId: string) {
        return this.clientPool.getBridgedClientByUserId(server, userId);
    }

    public getBridgedClientsForUserId(userId: string) {
        return this.clientPool.getBridgedClientsForUserId(userId);
    }

    public getBridgedClientsForRegex(regex: string) {
        return this.clientPool.getBridgedClientsForRegex(regex);
    }

    public getBridgedClient(server: IrcServer, userId: string, displayName?: string) {
        return this.clientPool.getBridgedClient(server, userId, displayName);
    }

    public getServer(domainName: string) {
        return this.ircServers.find((s) => s.domain === domainName) || null;
    }

    public getServers() {
        return this.ircServers || [];
    }

    public getMemberListSyncer(server: IrcServer) {
        return this.memberListSyncers[server.domain];
    }

    // TODO: Check how many of the below functions need to reside on IrcBridge still.
    public aliasToIrcChannel(alias: string) {
        const ircServer = this.getServers().find((s) => s.claimsAlias(alias));
        if (!ircServer) {
            return {};
        }
        return {
            server: ircServer,
            channel: ircServer.getChannelFromAlias(alias)
        };
    }

    public getServerForUserId(userId: string) {
        return this.getServers().find((s) => s.claimsUserId(userId)) || null;
    }

    public async matrixToIrcUser(user: MatrixUser) {
        const server = this.getServerForUserId(user.getId());
        const ircInfo = {
            server: server,
            nick: server ? server.getNickFromUserId(user.getId()) : null
        };
        if (!ircInfo.server || !ircInfo.nick) {
            throw Error("User ID " + user.getId() + " doesn't map to a server/nick");
        }
        return new IrcUser(ircInfo.server, ircInfo.nick, true);
    }

    public async trackChannel(server: IrcServer, channel: string, key?: string): Promise<IrcRoom> {
        if (!server.isBotEnabled()) {
            log.info("trackChannel: Bot is disabled.");
            return new IrcRoom(server, channel);
        }
        const client = await this.getBotClient(server);
        try {
            return await client.joinChannel(channel, key);
        }
        catch (ex) {
            log.error(ex);
            throw Error("Failed to join channel");
        }
    }

    public connectToIrcNetworks() {
        return promiseutil.allSettled(this.ircServers.map((server) =>
            Bluebird.cast(this.clientPool.loginToServer(server))
        ));
    }

    /**
     * Determines if a nick name already exists.
     */
    public async checkNickExists(server: IrcServer, nick: string) {
        log.info("Querying for nick %s on %s", nick, server.domain);
        const client = await this.getBotClient(server);
        return await client.whois(nick) !== null;
    }

    public async joinBot(ircRoom: IrcRoom) {
        if (!ircRoom.server.isBotEnabled()) {
            log.info("joinBot: Bot is disabled.");
            return;
        }
        const client = await this.getBotClient(ircRoom.server);
        try {
            await client.joinChannel(ircRoom.channel);
        }
        catch (ex) {
            log.error("Bot failed to join channel %s", ircRoom.channel);
        }
    }

    public async partBot(ircRoom: IrcRoom) {
        log.info(
            "Parting bot from %s on %s", ircRoom.channel, ircRoom.server.domain
        );
        const client = await this.getBotClient(ircRoom.server);
        await client.leaveChannel(ircRoom.channel);
    }

    public sendIrcAction(ircRoom: IrcRoom, bridgedClient: BridgedClient, action: IrcAction) {
        log.info(
            "Sending IRC message in %s as %s (connected=%s)",
            ircRoom.channel, bridgedClient.nick, Boolean(bridgedClient.unsafeClient)
        );
        return bridgedClient.sendAction(ircRoom, action);
    }

    public async getBotClient(server: IrcServer) {
        const botClient = this.clientPool.getBot(server);
        if (botClient) {
            return botClient;
        }
        return this.clientPool.loginToServer(server);
    }

    private async fetchJoinedRooms() {
        /** Fetching joined rooms is quicker on larger homeservers than trying to
         * /join each room in the mappings list. To ensure we start quicker,
         * the bridge will block on this call rather than blocking on all join calls.
         * On the most overloaded servers even this call may take several attempts,
         * so it will block indefinitely.
         */
        const bot = this.bridge.getBot();
        let gotRooms = false;
        while (!gotRooms) {
            try {
                const roomIds = await bot.getJoinedRooms();
                gotRooms = true;
                this.joinedRoomList = roomIds;
                log.info(`ASBot is in ${roomIds.length} rooms!`);
            }
            catch (ex) {
                log.error(`Failed to fetch roomlist from joined_rooms: ${ex}. Retrying`);
                await Bluebird.delay(DELAY_FETCH_ROOM_LIST_MS);
            }
        }
    }

    private async onRoomUpgrade(oldRoomId: string, newRoomId: string) {
        log.info(`Room has been upgraded from ${oldRoomId} to ${newRoomId}`);
        log.info("Migrating channels");
        await this.getStore().roomUpgradeOnRoomMigrated(oldRoomId, newRoomId);
        // Get the channels for the room_id
        const rooms = await this.getStore().getIrcChannelsForRoomId(newRoomId);
        // Get users who we wish to leave.
        const asBot = this.bridge.getBot();
        log.info("Migrating state");
        const stateEvents = await asBot.getClient().roomState(oldRoomId);
        //TODO:  _getRoomInfo is a private func and should be replaced.
        const roomInfo = asBot._getRoomInfo(oldRoomId, {
            state: {
                events: stateEvents
            }
        });
        const bridgingEvent = stateEvents.find((ev: {type: string}) => ev.type === "m.room.bridging");
        const bridgeInfoEvent = stateEvents.find((ev: {type: string}) => ev.type === BridgeStateSyncer.EventType);
        if (bridgingEvent) {
            try {
                await this.bridge.getIntent().sendStateEvent(
                    newRoomId,
                    bridgingEvent.type,
                    bridgingEvent.state_key,
                    bridgingEvent.content
                );
                log.info("m.room.bridging event copied to new room");
            }
            catch (ex) {
                // We may not have permissions to do so, which means we are basically stuffed.
                log.warn(`Could not send m.room.bridging event to new room: ${ex}`);
            }
        }
        if (bridgeInfoEvent) {
            try {
                await this.bridge.getIntent().sendStateEvent(
                    newRoomId,
                    bridgeInfoEvent.type,
                    bridgingEvent.state_key,
                    bridgingEvent.content
                );
                log.info("Bridge info event copied to new room");
            }
            catch (ex) {
                // We may not have permissions to do so, which means we are basically stuffed.
                log.warn(`Could not send bridge info event to new room: ${ex}`);
            }
        }
        log.info("Migrating ghosts");
        await Bluebird.all(rooms.map((room) => {
            return this.getBridgedClient(room.getServer(), roomInfo.realJoinedUsers[0]).then((client) => {
                // This will invoke NAMES and make members join the new room,
                // so we don't need to await it.
                client.getNicks(room.getChannel());
                log.info(
                    `Leaving ${roomInfo.remoteJoinedUsers.length} users from old room ${oldRoomId}.`
                );
                this.memberListSyncers[room.getServer().domain].addToLeavePool(
                    roomInfo.remoteJoinedUsers,
                    oldRoomId,
                    room.getChannel(),
                );
            })
        }));
        log.info(`Ghost migration to ${newRoomId} complete`);
    }

    public async connectionReap(logCb: (line: string) => void, serverName: string,
                                maxIdleHours: number, reason = "User is inactive", dry = false,
                                defaultOnline?: boolean, excludeRegex?: string) {
        if (!this.activityTracker) {
            throw Error("activityTracker is not enabled");
        }
        if (!maxIdleHours || maxIdleHours < 0) {
            throw Error("'since' must be greater than 0");
        }
        const maxIdleTime = maxIdleHours * 60 * 60 * 1000;
        const server = serverName ? this.getServer(serverName) : this.getServers()[0];
        if (server === null) {
            throw Error("Server not found");
        }
        log.warn(`Running connection reaper for ${serverName} dryrun=${dry}`);
        const req = new BridgeRequest(this.bridge.getRequestFactory().newRequest());
        logCb(`Connection reaping for ${serverName}`);
        const users: (string|null)[] = this.clientPool.getConnectedMatrixUsersForServer(server);
        logCb(`Found ${users.length} real users for ${serverName}`);
        const exclude = excludeRegex ? new RegExp(excludeRegex) : null;
        let offlineCount = 0;
        for (const userId of users) {
            if (!userId) {
                // The bot user has a userId of null, ignore it.
                continue;
            }
            const status = await this.activityTracker.isUserOnline(userId, maxIdleTime, defaultOnline);
            if (status.online) {
                continue;
            }
            const clients = this.clientPool.getBridgedClientsForUserId(userId);
            if (exclude && exclude.exec(userId)) {
                logCb(`${userId} is excluded`);
                continue;
            }
            if (clients.length === 0) {
                logCb(`${userId} has no active clients`);
                continue;
            }
            const quitRes = dry ? "dry-run" : await this.matrixHandler.quitUser(req, userId, clients, null, reason);
            if (quitRes !== null) {
                logCb(`Didn't quit ${userId}: ${quitRes}`);
                continue;
            }
            logCb(`Quit ${userId}`);
            // To avoid us catching them again for maxIdleHours
            offlineCount++;
        }
        logCb(`Quit ${offlineCount}/${users.length}`);
    }

    public async atBridgedRoomLimit() {
        const limit = this.config.ircService.provisioning?.roomLimit;
        if (!limit) {
            return false;
        }
        const current = await this.dataStore.getRoomCount();
        return current >= limit;
    }
}
