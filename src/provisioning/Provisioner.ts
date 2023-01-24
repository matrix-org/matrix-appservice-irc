import * as express from "express";
import { ValidateFunction } from "ajv";
import {
    ApiError,
    ErrCode,
    MatrixRoom,
    MatrixUser,
    MembershipQueue,
    PowerLevelContent,
    ProvisioningApi,
    ProvisioningRequest,
    Rules,
    UserMembership
} from "matrix-appservice-bridge";
import * as promiseutil from "../promiseutil";
import { Defer } from "../promiseutil";
import { IrcRoom } from "../models/IrcRoom";
import { IrcAction } from "../models/IrcAction";
import { BridgeRequest, BridgeRequestData } from "../models/BridgeRequest";
import logging, { RequestLogger } from "../logging";
import { IrcServer } from "../irc/IrcServer";
import { IrcUser } from "../models/IrcUser";
import { GetNicksResponseOperators } from "../irc/BridgedClient";
import { NeDBDataStore } from "../datastore/NedbDataStore";
import {
    ajv,
    IrcErrCode,
    IrcProvisioningError,
    isValidListingsParams,
    isValidQueryLinkBody,
    isValidRequestLinkBody,
    isValidUnlinkBody,
} from "./Schema";
import { IrcBridge } from "../bridge/IrcBridge";

const log = logging("Provisioner");

type BridgingStatus = "pending"|"success"|"failure";
interface MRoomBridgingContent extends Record<string, unknown> {
    user_id: string;
    status: BridgingStatus;
}

interface PendingRequest {
    userId: string;
    defer: Defer<unknown>;
    log: RequestLogger;
}

export interface ProvisionerConfig {
    enabled: boolean;
    requestTimeoutSeconds: number;
    rules?: Rules;
    roomLimit?: number;
    http?: {
        port: number;
        host?: string;
    };
    // We allow this to be unspecified, so it will fall back to the homeserver token
    secret?: string;
    apiPrefix?: string;
    openIdDisallowedIpRanges?: string[];
}

interface StrictProvisionerConfig extends ProvisionerConfig {
    secret: string;
}

const LINK_REQUIRED_POWER_DEFAULT = 50;

class ValidationError extends ApiError {
    constructor(validator: ValidateFunction) {
        super(
            "Malformed request",
            ErrCode.BadValue,
            undefined,
            {
                errors: ajv.errorsText(validator.errors),
            },
        );
    }
}

export class Provisioner extends ProvisioningApi {
    private pendingRequests: {
        [domain: string]: Map<string, PendingRequest>; // nick -> request
    } = {};

    constructor(
        readonly ircBridge: IrcBridge,
        readonly membershipQueue: MembershipQueue,
        readonly config: StrictProvisionerConfig,
    ) {
        super(
            ircBridge.getStore(),
            {
                provisioningToken: config.secret,
                apiPrefix: config.apiPrefix,
                disallowedIpRanges: config.openIdDisallowedIpRanges,
                ratelimit: true,
                widgetTokenPrefix: "ircbr-wdt-",
                widgetFrontendLocation: "public",
                // Use the bridge express application unless a config was specified for provisioning
                expressApp: config.http ? undefined : ircBridge.getAppServiceBridge().appService.expressApp,
            },
        );

        if (!config.enabled) {
            log.info("Provisioning disabled, endpoints will respond with an error code");
            // Disable all provision endpoints, responding with an error instead
            this.baseRoute.use((req, res, next) => {
                return next(new ApiError("Provisioning not enabled", ErrCode.DisabledFeature));
            });
            return;
        }

        if (this.store instanceof NeDBDataStore) {
            // Note: we don't really want to encourage NeDB for new deployments, and setting up
            // support for this in NeDB would require us to create a new store. The bridge should
            // fail appropriately with an error if the user attempts to use widgets while the
            // bridge is using NeDB.
            log.warn(
                "Provisioner is incompatible with NeDB store. Widget requests will not be handled."
            );
        }

        const wrapHandler = (handler: (req: ProvisioningRequest) => Promise<unknown>) => {
            return async(req: ProvisioningRequest, res: express.Response) => {
                try {
                    const result = (await handler.call(this, req)) || {};
                    req.log.debug(`Sending result: ${JSON.stringify(result)}`);
                    res.json(result);
                }
                catch (e) {
                    if (res.headersSent) {
                        return;
                    }
                    if (e instanceof IrcProvisioningError || e instanceof ApiError) {
                        // FIXME: Should do ApiError.apply but it breaks tests due to using .send instead of .json
                        res.status(e.statusCode).json(e.jsonBody);
                    }
                    else {
                        req.log.error('Unknown error', e);
                        // Send a generic error
                        const err = new ApiError("An internal error occurred");
                        res.status(err.statusCode).json(err.jsonBody);
                    }
                }
            }
        }
        this.addRoute("post", "/link", wrapHandler(this.requestLink), "requestLink");
        this.addRoute("post", "/unlink", wrapHandler(this.unlink), "unlink");
        this.addRoute("get", "/listlinks/:roomId", wrapHandler(this.listings), "listings");
        this.addRoute("post", "/querylink", wrapHandler(this.queryLink), "queryLink");
        this.addRoute("get", "/querynetworks", wrapHandler(this.queryNetworks), "queryNetworks");
        this.addRoute("get", "/limits", wrapHandler(this.getLimits), "limits");
    }

    public async start(): Promise<void> {
        if (this.config.http) {
            await super.start(this.config.http.port, this.config.http.host);
        }
        log.info("Provisioning API ready")
    }

    /**
     * Create a request to be passed internally to the provisioner.
     * @param fnName The function name to be called.
     * @param userId The userId, if specific to a user.
     * @param body The body of the request.
     * @param params The url parameters of the request.
     * @returns A ProvisioningRequest object.
     */
    static createFakeRequest(
        fnName: string,
        userId = "-internal-",
        params?: { [key: string]: string },
        body?: unknown,
    ): ProvisioningRequest {
        return new ProvisioningRequest(
            {
                body: body || {},
                query: {},
                params,
            } as never,
            userId,
            "provisioner",
            fnName,
        );
    }

    private async updateBridgingState (roomId: string, userId: string, status: BridgingStatus, skey: string) {
        const intent = this.ircBridge.getAppServiceBridge().getIntent();
        try {
            await intent.sendStateEvent(roomId, 'm.room.bridging', skey, {
                user_id: userId,
                status,
            } as MRoomBridgingContent);
        }
        catch (err) {
            throw new Error(`Could not update m.room.bridging state in ${roomId}`);
        }
    }

    private async userHasProvisioningPower(
        req: ProvisioningRequest,
        userId: string,
        roomId: string,
    ): Promise<boolean> {
        req.log.info(`Check power level of ${userId} in room ${roomId}`);
        const intent = this.ircBridge.getAppServiceBridge().getIntent();

        let powerState = null;

        await this.membershipQueue.join(roomId, undefined, req);
        try {
            await this.ircBridge.getAppServiceBridge().canProvisionRoom(roomId);
        }
        catch (err) {
            throw new IrcProvisioningError(
                'Room failed validation. You may be attempting to "double bridge" this room.' +
                ' Error: ' + err,
                IrcErrCode.DoubleBridge
            );
        }

        try {
            powerState = await intent.getStateEvent(roomId, 'm.room.power_levels');
        }
        catch (err) {
            req.log.error(`Error retrieving power levels (${err.data.error})`);
            throw new ApiError(`Could not retrieve power levels for ${roomId}`);
        }

        // In 10 minutes
        setTimeout(() => {
            this.leaveMatrixRoomIfUnprovisioned(req, roomId);
        }, 10 * 60 * 1000);

        let actualPower = 0;
        if (powerState.users[userId] !== undefined) {
            actualPower = powerState.users[userId];
        }
        else if (powerState.users_default !== undefined) {
            actualPower = powerState.users_default;
        }

        let requiredPower = LINK_REQUIRED_POWER_DEFAULT;
        if (powerState.events["m.room.power_levels"] !== undefined) {
            requiredPower = powerState.events["m.room.power_levels"]
        }
        else if (powerState.state_default !== undefined) {
            requiredPower = powerState.state_default;
        }

        return actualPower >= requiredPower;
    }

    /**
     * Do a series of checks before contacting an operator for permission to create
     *  a provisioned mapping. If the operator responds with 'yes' or 'y', the mapping
     *  is created.
     * The checks done are the following:
     *  - (Matrix) Check power level of user is high enough
     *  - (IRC) Check that op's nick is actually a channel op
     *  - (Matrix) check room state to prevent route looping: don't bridge the same
     *    room-channel pair
     *  - (Matrix) update room state m.room.brdiging
     */
    private async authoriseProvisioning(
        req: ProvisioningRequest,
        server: IrcServer,
        userId: string,
        ircChannel: string,
        roomId: string,
        opNick: string,
        key?: string,
    ): Promise<void> {
        const ircDomain = server.domain;

        const existing = this.getRequest(server, opNick);
        if (existing) {
            const from = existing.userId;
            throw new IrcProvisioningError(
                `Bridging request already sent to ${opNick} on ${server.domain} from ${from}`,
                IrcErrCode.ExistingRequest,
            );
        }

        // (Matrix) Check power level of user
        const hasPower = await this.userHasProvisioningPower(req, userId, roomId);
        if (!hasPower) {
            throw new IrcProvisioningError(
                `User does not possess high enough power level`,
                IrcErrCode.NotEnoughPower,
            );
        }

        // (IRC) Check that op's nick is actually op
        req.log.info(`Check that op's nick is actually op`);

        const botClient = await this.ircBridge.getBotClient(server);

        const info = await botClient.getOperators(ircChannel, {key : key});

        if (!info.names.has(opNick)) {
            throw new IrcProvisioningError(
                `Provided user is not in channel ${ircChannel}.`,
                IrcErrCode.BadOpTarget,
            );
        }

        if (!info.operatorNicks.includes(opNick)) {
            throw new IrcProvisioningError(
                `Provided user is not an op of ${ircChannel}.`,
                IrcErrCode.BadOpTarget,
            );
        }

        // State key for m.room.bridging
        const skey = `irc://${ircDomain}/${ircChannel}`;

        const intent = this.ircBridge.getAppServiceBridge().getIntent();
        let wholeBridgingState: {
            type: string;
            state_key: string;
            sender: string;
            content: MRoomBridgingContent;
        }|undefined = undefined;

        // (Matrix) check room state to prevent route looping
        try {
            const roomState = await intent.roomState(roomId) as
                {type: string; sender: string; state_key: string, content: MRoomBridgingContent}[];
            wholeBridgingState = roomState.find(
                e => e.type === 'm.room.bridging' && e.state_key === skey
            );
        }
        catch (err) {
            // The request to discover bridging state has failed

            // http-api error indicated by errcode
            if (err.body?.errcode) {
                //  ignore M_NOT_FOUND: this bridging does not exist
                if (err.body.errcode !== 'M_NOT_FOUND') {
                    throw new Error(err.body.error);
                }
            }
            else {
                throw err;
            }
        }

        // Bridging state exists and is either success or pending (ignore failures)
        if (wholeBridgingState && wholeBridgingState.content) {
            const bridgingState = wholeBridgingState.content;

            if (bridgingState.status !== 'failure') {
                // If bridging state sender is this bot
                if (wholeBridgingState.sender !== intent.userId) {
                    // If it is from a different sender, fail
                    throw new IrcProvisioningError(
                        "A request to create this mapping has already been sent",
                        IrcErrCode.ExistingRequest,
                        undefined,
                        {
                            status: bridgingState.status,
                            bridger: bridgingState.user_id,
                        },
                    );
                }
                // Success, already pending/success
                req.log.info(
                    `Bridging state already exists in room ${roomId} ` +
                    `(status = ${bridgingState.status},` +
                    ` bridger = ${bridgingState.user_id}.)`
                );

                if (bridgingState.status === 'success') {
                    // This indicates success, so check that the mapping exists in the
                    //  database

                    let entry = null;
                    try {
                        entry = await this.ircBridge.getStore()
                            .getRoom(roomId, ircDomain, ircChannel, 'provision');
                    }
                    catch (err) {
                        req.log.error(err.stack);
                        throw new Error(
                            `Error whilst checking for previously ` +
                            `successful provisioning of ` +
                            `${roomId}<-->${ircChannel}`
                        );
                    }

                    if (!entry) {
                        // Update the bridging state to be a failure
                        req.log.warn(
                            `Bridging state in room states successful mapping, `+
                            `but the bridge is not aware of provisioning. The ` +
                            `bridge will update the state in the room to failure ` +
                            `and continue with the provisioning request.`
                        );
                        try {
                            await this.updateBridgingState(roomId, userId, 'failure', skey);
                        }
                        catch (err) {
                            req.log.error(err.stack);
                            throw new Error(
                                `Bridging state success and mapping does not ` +
                                `exist, but could not update bridging state ` +
                                `${skey} of ${roomId} to failure.`
                            );
                        }
                    }
                } // If pending, resend the message to the op as if it were the original
                else if (bridgingState.status === 'pending') {
                    // _getRequest has not returned a pending request (see previously)
                    req.log.warn(
                        `Bridging state in room states pending mapping, ` +
                        `but the bridge is not waiting for a reply from ` +
                        `an op. The bridge will continue with the ` +
                        `provisioning request, sending another message ` +
                        `to the op in case the server was restarted`
                    );
                }
            }
        }

        req.log.info(`Sending pending m.room.bridging to ${roomId}, state key = ${skey}`);

        // (Matrix) update room state
        // Send pending m.room.bridging
        await this.updateBridgingState(roomId, userId, 'pending', skey);

        // (IRC) Ask operator for authorisation
        // Time that operator has to respond before giving up
        const timeoutSeconds = this.config.requestTimeoutSeconds;

        // Deliberately not awaiting on this so that 200 OK is returned
        req.log.info(`Contacting operator`);
        this.createAuthorisedLink(
            req, server, opNick, ircChannel, key,
            roomId, userId, skey, timeoutSeconds);
    }

    private async sendToUser(receiverNick: string, server: IrcServer, message: string): Promise<void> {
        const botClient = await this.ircBridge.getBotClient(server);
        return this.ircBridge.sendIrcAction(
            new IrcRoom(server, receiverNick),
            botClient,
            new IrcAction("message", message)
        );
    }

    /**
     * Contact an operator, asking for authorisation for a mapping, and if they reply
     * 'yes' or 'y', create the mapping.
     */
    private async createAuthorisedLink(
        req: ProvisioningRequest,
        server: IrcServer,
        opNick: string,
        ircChannel: string,
        key: string|undefined,
        roomId: string,
        userId: string,
        skey: string,
        timeoutSeconds: number,
    ): Promise<void> {
        const d = promiseutil.defer();

        this.setRequest(server, opNick, {userId: userId, defer: d, log: req.log});

        // Get room name
        const matrixClient = this.ircBridge.getAppServiceBridge().getIntent();

        let nameState = null;
        try {
            nameState = await matrixClient.getStateEvent(roomId, 'm.room.name');
        }
        catch (err) {
            if (err.stack && err.message) {
                req.log.error(`Error retrieving room name (${err.message})`);
                req.log.error(err.stack);
            }
            else if (err.data.error) {
                req.log.error(`Error retrieving room name (${err.data.error})`);
            }
            else {
                req.log.error(`Error retrieving name`);
                req.log.error(err);
            }
        }

        // Get canonical alias
        let aliasState = null;
        try {
            aliasState = await matrixClient.getStateEvent(roomId, 'm.room.canonical_alias');
        }
        catch (err) {
            if (err.stack && err.message) {
                req.log.error(`Error retrieving alias (${err.message})`);
                req.log.error(err.stack);
            }
            else if (err.data.error) {
                req.log.error(`Error retrieving alias (${err.data.error})`);
            }
            else {
                req.log.error(`Error retrieving alias`);
                req.log.error(err);
            }
        }

        let roomDesc: string | undefined;
        let matrixToLink = `https://matrix.to/#/${roomId}`;

        if (aliasState && typeof aliasState.alias === 'string') {
            roomDesc = aliasState.alias;
            matrixToLink = `https://matrix.to/#/${aliasState.alias}`;
        }

        if (nameState && typeof nameState.name === 'string') {
            roomDesc = `'${nameState.name}'`;
        }

        if (roomDesc) {
            roomDesc = `${roomDesc} (${matrixToLink})`;
        }
        else {
            roomDesc = `${matrixToLink}`;
        }

        await this.sendToUser(opNick, server,
            `${userId} has requested to bridge ${roomDesc} with ${ircChannel} on this IRC ` +
            `network. Respond with 'yes' or 'y' to allow, or simply ignore this message to ` +
            `disallow. You have ${timeoutSeconds} seconds from when this message was sent.`);

        try {
            await d.promise.timeout(timeoutSeconds * 1000);
            this.removeRequest(server, opNick);
        }
        catch (err) {
            req.log.info(`Operator ${opNick} did not respond (${err.message})`);
            await this.updateBridgingState(roomId, userId, 'failure', skey);
            this.removeRequest(server, opNick);
            return;
        }
        try {
            await this.doLink(req, server, ircChannel, key, roomId, userId);
        }
        catch (err) {
            req.log.error(err.stack);
            req.log.error(`Failed to create link following authorisation (${err.message})`);
            await this.updateBridgingState(roomId, userId, 'failure', skey);
            this.removeRequest(server, opNick);
            throw err;
        }
        await this.updateBridgingState(roomId, userId, 'success', skey);
        // Send bridge info state event
        if (this.ircBridge.stateSyncer) {
            const intent = this.ircBridge.getAppServiceBridge().getIntent();
            const infoMapping = await this.ircBridge.stateSyncer.createInitialState(roomId, {
                channel: ircChannel,
                networkId: server.getNetworkId(),
            })
            await intent.sendStateEvent(
                roomId,
                infoMapping.type,
                infoMapping.state_key,
                infoMapping.content as unknown as Record<string, unknown>,
            );
        }
    }

    private removeRequest (server: IrcServer, opNick: string) {
        this.pendingRequests[server.domain]?.delete(opNick);
    }

    /**
     * Returns a pending request if it's promise isPending(), otherwise null
     */
    private getRequest(server: IrcServer, opNick: string) {
        const req = this.pendingRequests[server.domain]?.get(opNick);
        if (req?.defer.promise.isPending()) {
            return req;
        }
        return null;
    }

    private setRequest (server: IrcServer, opNick: string, request: PendingRequest) {
        if (!this.pendingRequests[server.domain]) {
            this.pendingRequests[server.domain] = new Map();
        }
        this.pendingRequests[server.domain]?.set(opNick, request);
    }

    public async handlePm (server: IrcServer, fromUser: IrcUser, text: string) {
        if (!['y', 'yes'].includes(text.trim().toLowerCase())) {
            log.warn(`Provisioner only handles text 'yes'/'y' ` +
                    `(from ${fromUser.nick} on ${server.domain})`);

            await this.sendToUser(
                fromUser.nick, server,
                'Please respond with "yes" or "y".'
            );
            return;
        }
        const request = this.getRequest(server, fromUser.nick);
        if (request) {
            request.log.info(`${fromUser.nick} has authorised a new provisioning`);
            request.defer.resolve();

            await this.sendToUser(
                fromUser.nick, server,
                'Thanks for your response, bridge request authorised.'
            );

            return;
        }
        log.warn(`Provisioner was not expecting PM from ${fromUser.nick} on ${server.domain}`);
        await this.sendToUser(
            fromUser.nick, server,
            'The bot was not expecting a message from you. You might have already replied to a request.'
        );
    }

    /**
     * Get information that might be useful prior to calling requestLink
     * @returns An array of IRC chan op nicks
     */
    public async queryLink(req: ProvisioningRequest): Promise<{operators: string[]}> {
        const body = req.body as unknown;
        if (!isValidQueryLinkBody(body)) {
            throw new ValidationError(isValidQueryLinkBody);
        }

        const ircDomain = body.remote_room_server;
        let ircChannel = body.remote_room_channel;
        const key = body.key ?? undefined; // Optional key

        const queryInfo: {operators: string[]} = {
            // Array of operator nicks
            operators: []
        };

        // Try to find the domain requested for linking
        //TODO: ircDomain might include protocol, i.e. irc://irc.freenode.net
        const server = this.ircBridge.getServer(ircDomain);

        if (!server) {
            throw new Error(`Server not found ${ircDomain}`);
        }

        const botClient = await this.ircBridge.getBotClient(server);

        ircChannel = botClient.caseFold(ircChannel);

        if (server.isExcludedChannel(ircChannel)) {
            throw new Error(`Server is configured to exclude channel ${ircChannel}`);
        }

        let opsInfo: GetNicksResponseOperators;

        try {
            opsInfo = await botClient.getOperators(ircChannel,
                {
                    key: key,
                    cacheDurationMs: 1000 * 60 * 5
                }
            );
        }
        catch (err) {
            req.log.error(err.stack);
            throw new Error(`Failed to get operators for channel ${ircChannel} (${err.message})`);
        }

        queryInfo.operators = opsInfo.operatorNicks;

        // Exclude the bot, which has to join to get the operators
        queryInfo.operators = queryInfo.operators.filter(
            (nick) => {
                return nick !== botClient.nick;
            }
        );

        return queryInfo;
    }

    /**
     * Get the list of currently network instances.
     */
    public async queryNetworks() {
        const thirdParty = await this.ircBridge.getThirdPartyProtocol();

        return {
            servers: thirdParty.instances,
        };
    }

    /**
     * Link an IRC channel to a matrix room ID.
     */
    public async requestLink(req: ProvisioningRequest): Promise<void> {
        const body = req.body as unknown;
        if (!isValidRequestLinkBody(body)) {
            throw new ValidationError(isValidRequestLinkBody);
        }

        if (await this.ircBridge.atBridgedRoomLimit()) {
            throw new IrcProvisioningError(
                `At maximum number of bridged rooms`,
                IrcErrCode.BridgeAtLimit,
            );
        }

        const userId = req.userId;
        if (!userId) {
            throw new ApiError('Missing `user_id` in body', ErrCode.BadValue);
        }

        const ircDomain = body.remote_room_server;
        let ircChannel = body.remote_room_channel;
        const roomId = body.matrix_room_id;
        const opNick = body.op_nick;
        const key = body.key ?? undefined;

        // Try to find the domain requested for linking
        //TODO: ircDomain might include protocol, i.e. irc://irc.freenode.net
        const server = this.ircBridge.getServer(ircDomain);

        if (!server) {
            throw new IrcProvisioningError(
                `Server not found`,
                IrcErrCode.UnknownNetwork,
            );
        }

        const botClient = await this.ircBridge.getBotClient(server);

        ircChannel = botClient.caseFold(ircChannel);

        if (server.isExcludedChannel(ircChannel)) {
            throw new IrcProvisioningError(
                `Server is configured to exclude channel`,
                IrcErrCode.UnknownChannel,
            );
        }

        const entry = await this.ircBridge.getStore().getRoom(roomId, ircDomain, ircChannel);
        if (!entry) {
            // Ask OP for provisioning authentication
            await this.authoriseProvisioning(req, server, userId, ircChannel, roomId, opNick, key);
        }
        else {
            throw new IrcProvisioningError(
                'Room mapping already exists',
                IrcErrCode.ExistingMapping,
                undefined,
                {
                    origin: entry.data.origin,
                }
            );
        }
    }

    public async doLink(
        req: ProvisioningRequest,
        server: IrcServer,
        ircChannel: string,
        key: string|undefined,
        roomId: string,
        userId: string,
    ): Promise<void> {
        const ircDomain = server.domain;
        const mappingLogId = `${roomId} <---> ${ircDomain}/${ircChannel}`;
        req.log.info(`Provisioning link for room ${mappingLogId}`);

        // Create rooms for the link
        const ircRoom = new IrcRoom(server, ircChannel);
        const mxRoom = new MatrixRoom(roomId);

        const entry = await this.ircBridge.getStore().getRoom(roomId, ircDomain, ircChannel);
        if (entry) {
            throw new IrcProvisioningError(
                'Room mapping already exists',
                IrcErrCode.ExistingMapping,
                undefined,
                {
                    origin: entry.data.origin,
                }
            );
        }

        // Cause the bot to join the new plumbed channel if it is enabled
        // TODO: key not persisted on restart
        if (server.isBotEnabled()) {
            const botClient = await this.ircBridge.getBotClient(server);
            await botClient.joinChannel(ircChannel, key);
        }

        await this.ircBridge.getStore().storeRoom(ircRoom, mxRoom, 'provision');

        try {
            // Cause the provisioner to join the IRC channel
            const bridgeReq = new BridgeRequest(
                this.ircBridge.getAppServiceBridge().getRequestFactory().newRequest<BridgeRequestData>()
            );
            const target = new MatrixUser(userId);
            // inject a fake join event which will do M->I connections and
            // therefore sync the member list
            await this.ircBridge.matrixHandler.onJoin(bridgeReq, {
                room_id: roomId,
                _injected: true,
                _frontier: true,
                state_key: userId,
                type: "m.room.member",
                content: {
                    membership: "join"
                },
                event_id: "!injected_provisioner",
            }, target);
        }
        catch (err) {
            // Not fatal, so log error and return success
            req.log.error(err);
        }
    }

    /**
     * Unlink an IRC channel from a matrix room ID
     * @param ignorePermissions If true, permissions are ignored (e.g. for bridge admins).
     * Otherwise, the user needs to be a Moderator in the Matrix room.
     */
    public async unlink(
        req: ProvisioningRequest,
        ignorePermissions = false,
    ): Promise<void> {
        const body = req.body as unknown;
        if (!isValidUnlinkBody(body)) {
            throw new ValidationError(isValidUnlinkBody);
        }

        const userId = req.userId;
        if (!userId) {
            throw new ApiError('Missing `user_id` in body', ErrCode.BadValue);
        }

        const ircDomain = body.remote_room_server;
        const ircChannel = body.remote_room_channel;
        const roomId = body.matrix_room_id;
        const mappingLogId = `${roomId} <-/-> ${ircDomain}/${ircChannel}`;

        req.log.info(`Provisioning unlink for room ${mappingLogId}`);

        // Try to find the domain requested for unlinking
        const server = this.ircBridge.getServer(ircDomain);

        if (!server) {
            throw new IrcProvisioningError(
                `Server not found`,
                IrcErrCode.UnknownNetwork,
            );
        }

        if (!ignorePermissions) {
            // Make sure the requester is a mod in the room
            const intent = this.ircBridge.getAppServiceBridge().getIntent();
            const stateEvents = await intent.roomState(roomId) as [{type: string; state_key: string; content: unknown}];
            // user_id must be JOINED and must have permission to modify power levels
            let isJoined = false;
            let hasPower = false;
            stateEvents.forEach(e => {
                if (e.type === "m.room.member" && e.state_key === userId) {
                    const content = e.content as {membership: UserMembership};
                    isJoined = content.membership === "join";
                }
                else if (e.type === "m.room.power_levels" && e.state_key === "") {
                    const content = e.content as PowerLevelContent;
                    // https://matrix.org/docs/spec/client_server/r0.6.0#m-room-power-levels
                    let powerRequired: unknown|number = content.state_default;
                    if (content.events && content.events["m.room.power_levels"]) {
                        powerRequired = content.events["m.room.power_levels"];
                    }
                    let power: unknown|number = content.users_default;
                    if (content.users && content.users[userId]) {
                        power = content.users[userId];
                    }
                    // Can be empty. Assume 0 as per spec.
                    // Can be empty. Assume LINK_REQUIRED_POWER_DEFAULT as per spec.
                    hasPower = (
                        typeof power === "number" ? power : 0)
                        >=
                        (typeof powerRequired === "number" ? powerRequired : LINK_REQUIRED_POWER_DEFAULT);
                }
            });
            if (!isJoined) {
                throw new IrcProvisioningError(`${userId} is not in the room`, IrcErrCode.NotEnoughPower)
            }
            if (!hasPower) {
                throw new IrcProvisioningError(
                    `${userId} does not have enough power in the room`,
                    IrcErrCode.NotEnoughPower,
                    undefined,
                    {
                        requiredPower: LINK_REQUIRED_POWER_DEFAULT,
                    }
                );
            }
        }


        // Delete the room link
        const entry = await this.ircBridge.getStore()
            .getRoom(roomId, ircDomain, ircChannel, 'provision');

        if (!entry) {
            throw new IrcProvisioningError('Provisioned room mapping does not exist', IrcErrCode.UnknownRoom);
        }
        await this.ircBridge.getStore().removeRoom(roomId, ircDomain, ircChannel, 'provision');

        // Leaving rooms should not cause unlink to fail
        try {
            await this.leaveIfUnprovisioned(req, roomId, server, ircChannel);
        }
        catch (err) {
            req.log.error(`Failed to cleanup after unlinking:`, err);
        }
    }

    /**
     * Force the bot to leave both sides of a provisioned mapping if there are no more mappings that
     * map either the channel or room. Force IRC clients to part the channel.
     */
    public async leaveIfUnprovisioned(
        req: ProvisioningRequest,
        roomId: string,
        server: IrcServer,
        ircChannel: string,
    ): Promise<void> {
        try {
            await Promise.all([
                this.partUnlinkedIrcClients(req, roomId, server, ircChannel),
                this.leaveMatrixVirtuals(req, roomId, server)
            ]);
        }
        catch (err) {
            // keep going, we still need to part the bot; this is just cleanup
            req.log.error(`Failed to unlink matrix/remote users from channel: ${err}`);
        }

        // Cause the bot to part the channel if there are no other rooms being mapped to this
        // channel
        const mxRooms = await this.ircBridge.getStore().getMatrixRoomsForChannel(server, ircChannel);
        if (mxRooms.length === 0 && server.isBotEnabled()) {
            const botClient = await this.ircBridge.getBotClient(server);
            req.log.info(`Leaving channel ${ircChannel} as there are no more provisioned mappings`);
            await botClient.leaveChannel(ircChannel);
        }

        await this.leaveMatrixRoomIfUnprovisioned(req, roomId);
    }

    /**
     * Parts IRC clients who should no longer be in the channel as a result of the given mapping being
     * unlinked.
     */
    private async partUnlinkedIrcClients(
        req: ProvisioningRequest,
        roomId: string,
        server: IrcServer,
        ircChannel: string,
    ): Promise<void> {
        // Get the full set of room IDs linked to this #channel
        const matrixRooms = await this.ircBridge.getStore().getMatrixRoomsForChannel(
            server, ircChannel
        );
        // make sure the unlinked room exists as we may have just removed it
        const exists = matrixRooms.find(r => r.getId() === roomId);
        if (!exists) {
            matrixRooms.push(new MatrixRoom(roomId));
        }


        // For each room, get the list of real matrix users and tally up how many times each one
        // appears as joined
        const joinedUserCounts: {[userId: string]: number} = {}; // user_id => Number
        const unlinkedUserIds: string[] = [];
        const intent = this.ircBridge.getAppServiceBridge().getIntent();
        const asBot = this.ircBridge.getAppServiceBridge().getBot();
        for (let i = 0; i < matrixRooms.length; i++) {
            let stateEvents = [];
            try {
                stateEvents = await intent.matrixClient.getRoomState(matrixRooms[i].getId());
            }
            catch (err) {
                req.log.error("Failed to hit /state for room " + matrixRooms[i].getId());
                req.log.error(err.stack);
            }

            // _getRoomInfo takes a particular format.
            const joinedRoom = {
                state: {
                    events: stateEvents
                }
            }
            const roomInfo = await asBot.getRoomInfo(matrixRooms[i].getId(), joinedRoom);
            for (let j = 0; j < roomInfo.realJoinedUsers.length; j++) {
                const userId: string = roomInfo.realJoinedUsers[j];
                if (!joinedUserCounts[userId]) {
                    joinedUserCounts[userId] = 0;
                }
                joinedUserCounts[userId] += 1;

                if (matrixRooms[i].getId() === roomId) { // the unlinked room
                    unlinkedUserIds.push(userId);
                }
            }
        }

        // Decrement counters for users who are in the unlinked mapping
        // as they are now "leaving". Part clients which have a tally of 0.
        unlinkedUserIds.forEach((userId) => {
            joinedUserCounts[userId] -= 1;
        });
        const partUserIds = Object.keys(joinedUserCounts).filter((userId) => {
            return joinedUserCounts[userId] === 0;
        });
        partUserIds.forEach((userId) => {
            req.log.info(`Parting user ${userId} from ${ircChannel} as mapping unlinked.`);
            const cli = this.ircBridge.getIrcUserFromCache(server, userId);
            if (!cli) {
                return; // client is disconnected
            }
            cli.leaveChannel(ircChannel, "Unlinked");
        });
        req.log.info(
            `Unlinked user_id tallies for ${ircChannel}: ${JSON.stringify(joinedUserCounts)}`
        );
    }

    private async leaveMatrixVirtuals(
        req: ProvisioningRequest,
        roomId: string,
        server: IrcServer,
    ): Promise<void> {
        const asBot = this.ircBridge.getAppServiceBridge().getBot();
        const intent = this.ircBridge.getAppServiceBridge().getIntent();
        const roomChannels = await this.ircBridge.getStore().getIrcChannelsForRoomId(
            roomId
        );
        if (roomChannels.length > 0) {
            req.log.warn(
                `Not leaving matrix virtuals from room, room is still bridged to ${roomChannels.length} channel(s)`
            );
            // We can't determine who should and shouldn't be in the room.
            return undefined;
        }
        const stateEvents = await intent.matrixClient.getRoomState(roomId);
        const roomInfo = await asBot.getRoomInfo(roomId, {
            state: {
                events: stateEvents
            }
        });
        req.log.info(`Leaving ${roomInfo.remoteJoinedUsers.length} virtual users from ${roomId}.`);
        return this.ircBridge.getMemberListSyncer(server).addToLeavePool(
            roomInfo.remoteJoinedUsers,
            roomId
        );
    }

    /**
     *  Cause the bot to leave the matrix room if there are no other channels being mapped to
     * this room
     */
    private async leaveMatrixRoomIfUnprovisioned(
        req: ProvisioningRequest,
        roomId: string,
    ): Promise<void> {
        const ircChannels = await this.ircBridge.getStore().getIrcChannelsForRoomId(roomId);
        const intent = this.ircBridge.getAppServiceBridge().getIntent();
        if (ircChannels.length === 0) {
            req.log.info(`Leaving room ${roomId} as there are no more provisioned mappings`);
            await intent.leave(roomId);
        }
    }

    /**
     * List all mappings currently provisioned with the given matrix_room_id
     */
    public async listings(req: ProvisioningRequest) {
        const params = req.params as unknown;
        if (!isValidListingsParams(params)) {
            throw new ValidationError(isValidListingsParams);
        }

        const mappings = await this.ircBridge.getStore().getProvisionedMappings(params.roomId);

        return mappings.map((entry) => {
            if (!entry.matrix || !entry.remote) {
                return false;
            }
            return {
                matrix_room_id : entry.matrix.getId(),
                remote_room_channel : entry.remote.get("channel"),
                remote_room_server : entry.remote.get("domain"),
            }
        }).filter((e) => e !== false);
    }

    private async getLimits() {
        const count = await this.ircBridge.getStore().getRoomCount();
        const limit = this.ircBridge.config.ircService.provisioning?.roomLimit || false;
        return {
            count,
            limit,
        };
    }
}
