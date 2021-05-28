import { Request } from "express";
import { IrcBridge } from "../bridge/IrcBridge";
import { Defer } from "../promiseutil";
import { ConfigValidator, MatrixRoom, MatrixUser } from "matrix-appservice-bridge";
import Bluebird from "bluebird";
import { IrcRoom } from "../models/IrcRoom";
import { IrcAction } from "../models/IrcAction";
import { BridgeRequest, BridgeRequestData } from "../models/BridgeRequest";
import { ProvisionRequest } from "./ProvisionRequest";
import logging, { RequestLogger } from "../logging";
import * as promiseutil from "../promiseutil";
import * as express from "express";
import { IrcServer } from "../irc/IrcServer";
import { IrcUser } from "../models/IrcUser";
import { GetNicksResponseOperators } from "../irc/BridgedClient";

const log = logging("Provisioner");

const matrixRoomIdValidation = {
    "type": "string",
    "pattern": "^!.*:.*$"
};

const validationProperties = {
    "matrix_room_id" : matrixRoomIdValidation,
    "remote_room_channel" : {
        "type": "string",
        "pattern": "^([#+&]|(![A-Z0-9]{5}))[^\\s:,]+$"
    },
    "remote_room_server" : {
        "type": "string",
        "pattern": "^[a-z\\.0-9:-]+$"
    },
    "op_nick" : {
        "type": "string"
    },
    "key" : {
        "type": "string"
    },
    "user_id" : {
        "type": "string"
    }
};

interface PendingRequest {
    userId: string;
    defer: Defer<unknown>;
    log: RequestLogger;
}

export class Provisioner {
    private pendingRequests: {
        [domain: string]: {
            [nick: string]: PendingRequest;
        };
    } = {};
    private linkValidator: ConfigValidator;
    private queryLinkValidator: ConfigValidator;
    private unlinkValidator: ConfigValidator;
    private roomIdValidator: ConfigValidator;
    constructor(private ircBridge: IrcBridge, private enabled: boolean, private requestTimeoutSeconds: number) {
        this.linkValidator = new ConfigValidator({
            "type": "object",
            "properties": validationProperties,
            "required": [
                "matrix_room_id",
                "remote_room_channel",
                "remote_room_server",
                "op_nick",
                "user_id"
            ]
        });
        this.queryLinkValidator = new ConfigValidator({
            "type": "object",
            "properties": validationProperties,
            "required": [
                "remote_room_channel",
                "remote_room_server"
            ]
        });
        this.unlinkValidator = new ConfigValidator({
            "type": "object",
            "properties": validationProperties,
            "required": [
                "matrix_room_id",
                "remote_room_channel",
                "remote_room_server",
                "user_id"
            ]
        });
        this.roomIdValidator = new ConfigValidator({
            "type": "object",
            "properties": {
                "matrix_room_id" : matrixRoomIdValidation
            }
        });

        if (enabled) {
            log.info("Starting provisioning...");
        }
        else {
            log.info("Provisioning disabled.");
        }

        const appservice = this.ircBridge.getAppServiceBridge().appService;
        const app = appservice?.expressApp;

        // Disable all provision endpoints by not calling 'next' and returning an error instead
        if (!enabled) {
            if (app) {
                app.use((req, res, next) => {
                    if (this.isProvisionRequest(req)) {
                        res.header("Access-Control-Allow-Origin", "*");
                        res.header("Access-Control-Allow-Headers",
                            "Origin, X-Requested-With, Content-Type, Accept");
                        res.status(500);
                        res.json({error : 'Provisioning is not enabled.'});
                    }
                    else {
                        next();
                    }
                });
            }
            return;
        }

        if (!app) {
            throw new Error('Could not start provisioning API');
        }

        app.use((req, res, next) => {
            // Deal with CORS (temporarily for s-web)
            if (this.isProvisionRequest(req)) {
                res.header("Access-Control-Allow-Origin", "*");
                res.header("Access-Control-Allow-Headers",
                    "Origin, X-Requested-With, Content-Type, Accept");
            }
            if (!this.ircBridge.getAppServiceBridge().requestCheckToken(req)) {
                res.status(403).send({
                    errcode: "M_FORBIDDEN",
                    error: "Bad token supplied"
                });
                return;
            }
            next();
        });

        app.post("/_matrix/provision/link",
            this.createProvisionEndpoint(this.requestLink, 'requestLink')
        );

        app.post("/_matrix/provision/unlink",
            this.createProvisionEndpoint(this.unlink, 'unlink')
        );

        app.get("/_matrix/provision/listlinks/:roomId",
            this.createProvisionEndpoint(this.listings, 'listings')
        );

        app.post("/_matrix/provision/querylink",
            this.createProvisionEndpoint(this.queryLink, 'queryLink')
        );

        app.get("/_matrix/provision/querynetworks",
            this.createProvisionEndpoint(this.queryNetworks, 'queryNetworks')
        );

        app.get("/_matrix/provision/limits",
            this.createProvisionEndpoint(this.getLimits, 'limits')
        );

        log.info("Provisioning started");
    }

    private createProvisionEndpoint(fn: (req: ProvisionRequest) => unknown, fnName: string) {
        return async (req: express.Request, res: express.Response) => {
            const pReq = new ProvisionRequest(req, fnName);
            pReq.log.info(
                'New provisioning request: ' + JSON.stringify(req.body) +
                ' params: ' + JSON.stringify(req.params)
            );
            try {
                let result = await fn.call(this, pReq);
                if (!result) {
                    result = {};
                }
                pReq.log.info(`Sending result: ${JSON.stringify(result)}`);
                res.json(result);
            }
            catch (err) {
                res.status(500).json({error: err.message});
                pReq.log.error(err.stack);
                throw err;
            }
        }
    }

    private isProvisionRequest(req: Request) {
        return req.url === '/_matrix/provision/unlink' ||
                req.url === '/_matrix/provision/link'||
                req.url === '/_matrix/provision/querynetworks' ||
                req.url === "/_matrix/provision/querylink" ||
                req.url.match(/^\/_matrix\/provision\/listlinks/)
    }

    private async updateBridgingState (roomId: string, userId: string,
                                       status: "pending"|"success"|"failure", skey: string) {
        const intent = this.ircBridge.getAppServiceBridge().getIntent();
        try {
            await intent.client.sendStateEvent(roomId, 'm.room.bridging', {
                user_id: userId,
                status,
            }, skey);
        }
        catch (err) {
            throw new Error(`Could not update m.room.bridging state in ${roomId}`);
        }
    }

    /**
     *  Utility function for attempting to send a request to a matrix endpoint
     *  that might be rate-limited.
     *
     *  This function will try `attempts` times to apply function `fn` to `obj` by
     *  calling fn.apply(obj, args), with args being any arguments passed to retry
     *  after `fn`. If an error occurs, the same will be tried again after
     *  `retryDelayMs`. If an error err is thrown by `fn` and err.data.retry_after_ms
     *  is set, it will be added to that delay.
     *
     *  If the number of attempts is reached, an error is thrown.
    */
    private async _retry<V>(req: ProvisionRequest, attempts: number, retryDelayMS: number, obj: unknown,
                            fn: (args: string) => V, args: string) {
        for (;attempts > 0; attempts--) {
            try {
                const val = await fn.apply(obj, [args]);
                return val;
            }
            catch (err) {
                const msg = err.data && err.data.error ? err.data.error : err.message;
                req.log.error(`Error doing rate limited action (${msg})`);

                let waitTimeMs = retryDelayMS;

                if (err.data && err.data.retry_after_ms && attempts > 0) {
                    waitTimeMs += err.data.retry_after_ms;
                }
                await Bluebird.delay(waitTimeMs);
            }
        }

        throw new Error(`Too many attempts to do rate limited action`);
    }

    private retry<V>(req: ProvisionRequest, attempts: number, retryDelayMS: number, obj: unknown,
                     fn: (args: string) => V, args: string) {
        return Bluebird.cast(this._retry(req, attempts, retryDelayMS, obj, fn, args));
    }

    private async userHasProvisioningPower(req: ProvisionRequest, userId: string, roomId: string) {
        req.log.info(`Check power level of ${userId} in room ${roomId}`);
        const matrixClient = this.ircBridge.getAppServiceBridge().getClientFactory().getClientAs();

        let powerState = null;

        // Try 100 times to join a room, or timeout after 10 min
        await this.retry(req, 100, 5000, matrixClient, matrixClient.joinRoom, roomId).timeout(600000);
        try {
            await this.ircBridge.getAppServiceBridge().canProvisionRoom(roomId);
        }
        catch (err) {
            req.log.error(`Room failed room validator check: (${err})`);
            throw new Error(
                'Room failed validation. You may be attempting to "double bridge" this room.' +
                ' Error: ' + err
            );
        }

        try {
            powerState = await matrixClient.getStateEvent(roomId, 'm.room.power_levels');
        }
        catch (err) {
            req.log.error(`Error retrieving power levels (${err.data.error})`);
            throw new Error('Could not retrieve your power levels for the room');
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

        let requiredPower = 50;
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
    private async authoriseProvisioning(req: ProvisionRequest, server: IrcServer, userId: string,
                                        ircChannel: string, roomId: string, opNick: string, key?: string) {
        const ircDomain = server.domain;

        const existing = this.getRequest(server, opNick);
        if (existing) {
            const from = existing.userId;
            throw new Error(`Bridging request already sent to `+
                            `${opNick} on ${server.domain} from ${from}`);
        }

        // (Matrix) Check power level of user
        const hasPower = await this.userHasProvisioningPower(req, userId, roomId);
        if (!hasPower) {
            throw new Error('User does not possess high enough power level');
        }

        // (IRC) Check that op's nick is actually op
        req.log.info(`Check that op's nick is actually op`);

        const botClient = await this.ircBridge.getBotClient(server);

        const info = await botClient.getOperators(ircChannel, {key : key});

        if (!info.nicks.includes(opNick)) {
            throw new Error(`Provided user is not in channel ${ircChannel}.`);
        }

        if (!info.operatorNicks.includes(opNick)) {
            throw new Error(`Provided user is not an op of ${ircChannel}.`);
        }

        // State key for m.room.bridging
        const skey = `irc://${ircDomain}/${ircChannel}`;

        const matrixClient = this.ircBridge.getAppServiceBridge().getClientFactory().getClientAs();
        let wholeBridgingState = null;

        // (Matrix) check room state to prevent route looping
        try {
            const roomState = await matrixClient.roomState(roomId);
            wholeBridgingState = roomState.find(
                (e: {type: string; state_key: string}) => {
                    return e.type === 'm.room.bridging' && e.state_key === skey
                }
            );
        }
        catch (err) {
            // The request to discover bridging state has failed

            // http-api error indicated by errcode
            if (err.errcode) {
                //  ignore M_NOT_FOUND: this bridging does not exist
                if (err.errcode !== 'M_NOT_FOUND') {
                    throw new Error(err.data.error);
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
                if (wholeBridgingState.sender !== matrixClient.credentials.userId) {
                    // If it is from a different sender, fail
                    throw new Error(
                        `A request to create this mapping has already been sent ` +
                        `(status = ${bridgingState.status},` +
                        ` bridger = ${bridgingState.user_id}. Ignoring request.`
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
        const timeoutSeconds = this.requestTimeoutSeconds;

        // Deliberately not awaiting on this so that 200 OK is returned
        req.log.info(`Contacting operator`);
        this.createAuthorisedLink(
            req, server, opNick, ircChannel, key,
            roomId, userId, skey, timeoutSeconds);
    }

    private async sendToUser(receiverNick: string, server: IrcServer, message: string) {
        const botClient = await this.ircBridge.getBotClient(server);
        return this.ircBridge.sendIrcAction(
            new IrcRoom(server, receiverNick),
            botClient,
            new IrcAction("message", message)
        );
    }

    // Contact an operator, asking for authorisation for a mapping, and if they reply
    //  'yes' or 'y', create the mapping.
    private async createAuthorisedLink(
        req: ProvisionRequest, server: IrcServer, opNick: string, ircChannel: string, key: string|undefined,
        roomId: string, userId: string, skey: string, timeoutSeconds: number) {
        const d = promiseutil.defer();

        this.setRequest(server, opNick, {userId: userId, defer: d, log: req.log});

        // Get room name
        const matrixClient = this.ircBridge.getAppServiceBridge().getClientFactory().getClientAs();

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

        let roomDesc = null;
        let matrixToLink = `https://matrix.to/#/${roomId}`;

        if (aliasState && aliasState.alias) {
            roomDesc = aliasState.alias;
            matrixToLink = `https://matrix.to/#/${aliasState.alias}`;
        }

        if (nameState && nameState.name) {
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
            req.log.info(`Failed to create link following authorisation (${err.message})`);
            await this.updateBridgingState(roomId, userId, 'failure', skey);
            this.removeRequest(server, opNick);
            return;
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
        if (this.pendingRequests[server.domain]) {
            delete this.pendingRequests[server.domain][opNick];
        }
    }

    // Returns a pending request if it's promise isPending(), otherwise null
    private getRequest(server: IrcServer, opNick: string) {
        const reqs = this.pendingRequests[server.domain];
        if (reqs) {
            if (!reqs[opNick]) {
                return null;
            }

            if (reqs[opNick].defer.promise.isPending()) {
                return reqs[opNick];
            }
        }
        return null;
    }

    private setRequest (server: IrcServer, opNick: string, request: PendingRequest) {
        if (!this.pendingRequests[server.domain]) {
            this.pendingRequests[server.domain] = {};
        }
        this.pendingRequests[server.domain][opNick] = request;
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

    // Get information that might be useful prior to calling requestLink
    //  returns
    //  {
    //   operators: ['operator1', 'operator2',...] // an array of IRC chan op nicks
    //  }
    public async queryLink(req: ProvisionRequest) {
        const options = req.body;
        const ircDomain = options.remote_room_server;
        let ircChannel = options.remote_room_channel;
        const key = options.key || undefined; // Optional key

        const queryInfo: {operators: string[]} = {
            // Array of operator nicks
            operators: []
        };

        try {
            this.queryLinkValidator.validate(options);
        }
        catch (err) {
            if (err._validationErrors) {
                const s = err._validationErrors.map((e: {field: string})=>{
                    return `${e.field} is malformed`;
                }).join(', ');
                throw new Error(s);
            }
            else {
                log.error(err);
                // change the message and throw
                throw new Error('Malformed parameters');
            }
        }

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

    // Get the list of currently network instances
    public async queryNetworks() {
        const thirdParty = await this.ircBridge.getThirdPartyProtocol();

        return {
            servers: thirdParty.instances
        };
    }

    // Link an IRC channel to a matrix room ID
    public async requestLink(req: ProvisionRequest) {
        const options = req.body;
        try {
            this.linkValidator.validate(options);
        }
        catch (err) {
            if (err._validationErrors) {
                const s = err._validationErrors.map((e: {field: string})=>{
                    return `${e.field} is malformed`;
                }).join(', ');
                throw new Error(s);
            }
            else {
                log.error(err);
                // change the message and throw
                throw new Error('Malformed parameters');
            }
        }

        if (await this.ircBridge.atBridgedRoomLimit()) {
            throw new Error('At maximum number of bridged rooms');
        }

        const ircDomain = options.remote_room_server;
        let ircChannel = options.remote_room_channel;
        const roomId = options.matrix_room_id;
        const opNick = options.op_nick;
        const key = options.key || undefined; // Optional key
        const userId = options.user_id;
        const mappingLogId = `${roomId} <---> ${ircDomain}/${ircChannel}`;

        // Try to find the domain requested for linking
        //TODO: ircDomain might include protocol, i.e. irc://irc.freenode.net
        const server = this.ircBridge.getServer(ircDomain);

        if (!server) {
            throw new Error(`Server requested for linking not found ('${ircDomain}')`);
        }

        const botClient = await this.ircBridge.getBotClient(server);

        ircChannel = botClient.caseFold(ircChannel);

        if (server.isExcludedChannel(ircChannel)) {
            throw new Error(`Server is configured to exclude given channel ('${ircChannel}')`);
        }

        const entry = await this.ircBridge.getStore().getRoom(roomId, ircDomain, ircChannel);
        if (!entry) {
            // Ask OP for provisioning authentication
            await this.authoriseProvisioning(req, server, userId, ircChannel, roomId, opNick, key);
        }
        else {
            throw new Error(`Room mapping already exists (${mappingLogId},` +
                            `origin = ${entry.data.origin})`);
        }
    }

    public async doLink(req: ProvisionRequest, server: IrcServer, ircChannel: string,
                        key: string|undefined, roomId: string, userId: string) {
        const ircDomain = server.domain;
        const mappingLogId = `${roomId} <---> ${ircDomain}/${ircChannel}`;
        req.log.info(`Provisioning link for room ${mappingLogId}`);

        // Create rooms for the link
        const ircRoom = new IrcRoom(server, ircChannel);
        const mxRoom = new MatrixRoom(roomId);

        const entry = await this.ircBridge.getStore().getRoom(roomId, ircDomain, ircChannel);
        if (entry) {
            throw new Error(`Room mapping already exists (${mappingLogId},` +
                            `origin = ${entry.data.origin})`);
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
            // Sync matrix users
            if (server.shouldSyncMembershipToMatrix("initial", ircChannel)) {
                await this.ircBridge.syncMembersInRoomToIrc(roomId, ircRoom);
            }
            // Sync IRC users.
            if (server.shouldSyncMembershipToIrc("initial")) {
                await (await this.ircBridge.getClientPool().getBridgedClient(server, userId)).getNicks(ircChannel);
            }
        }
        catch (err) {
            // Not fatal, so log error and return success
            req.log.error(err);
        }
    }

    /**
     * Unlink an IRC channel from a matrix room ID
     * @param req An ExpressJS-Request-like object which triggered the action. Its body should contain
     * the parameters for this unlink action.
     * @param ignorePermissions If true, permissions are ignored (e.g. for bridge admins).
     * Otherwise, the user needs to be a Moderator in the Matrix room.
     */
    public async unlink(req: ProvisionRequest, ignorePermissions = false) {
        const options = req.body;
        try {
            this.unlinkValidator.validate(options);
        }
        catch (err) {
            if (err._validationErrors) {
                const s = err._validationErrors.map((e: {instanceContext: string})=>{
                    return `${e.instanceContext} is malformed`;
                }).join(', ');
                throw new Error(s);
            }
            else {
                log.error(err);
                // change the message and throw
                throw new Error('Malformed parameters');
            }
        }

        const ircDomain = options.remote_room_server;
        const ircChannel = options.remote_room_channel;
        const roomId = options.matrix_room_id;
        const mappingLogId = `${roomId} <-/-> ${ircDomain}/${ircChannel}`;

        req.log.info(`Provisioning unlink for room ${mappingLogId}`);

        // Try to find the domain requested for unlinking
        const server = this.ircBridge.getServer(ircDomain);

        if (!server) {
            throw new Error("Server requested for linking not found");
        }

        if (!ignorePermissions) {
            // Make sure the requester is a mod in the room
            const botCli = this.ircBridge.getAppServiceBridge().getBot().getClient();
            const stateEvents = await botCli.roomState(roomId);
            // user_id must be JOINED and must have permission to modify power levels
            let isJoined = false;
            let hasPower = false;
            stateEvents.forEach((e: { type: string; state_key: string; content: {
                state_default?: number;
                users_default?: number;
                membership: string;
                users?: Record<string, number>;
                events?: Record<string, number>;
            };}) => {
                if (e.type === "m.room.member" && e.state_key === options.user_id) {
                    isJoined = e.content.membership === "join";
                }
                else if (e.type === "m.room.power_levels" && e.state_key === "") {
                    // https://matrix.org/docs/spec/client_server/r0.6.0#m-room-power-levels
                    let powerRequired = e.content.state_default || 50; // Can be empty. Assume 50 as per spec.
                    if (e.content.events && e.content.events["m.room.power_levels"]) {
                        powerRequired = e.content.events["m.room.power_levels"];
                    }
                    let power = e.content.users_default || 0; // Can be empty. Assume 0 as per spec.
                    if (e.content.users && e.content.users[options.user_id]) {
                        power = e.content.users[options.user_id];
                    }
                    hasPower = power >= powerRequired;
                }
            });
            if (!isJoined) {
                throw new Error(`${options.user_id} is not in the room`);
            }
            if (!hasPower) {
                throw new Error(`${options.user_id} is not a moderator in the room.`);
            }
        }


        // Delete the room link
        const entry = await this.ircBridge.getStore()
            .getRoom(roomId, ircDomain, ircChannel, 'provision');

        if (!entry) {
            throw new Error(`Provisioned room mapping does not exist (${mappingLogId})`);
        }
        await this.ircBridge.getStore().removeRoom(roomId, ircDomain, ircChannel, 'provision');

        // Leaving rooms should not cause unlink to fail
        try {
            await this.leaveIfUnprovisioned(req, roomId, server, ircChannel);
        }
        catch (err) {
            req.log.error(err.stack);
        }
    }

    // Force the bot to leave both sides of a provisioned mapping if there are no more mappings that
    //  map either the channel or room. Force IRC clients to part the channel.
    public async leaveIfUnprovisioned(req: ProvisionRequest, roomId: string, server: IrcServer, ircChannel: string) {
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

    // Parts IRC clients who should no longer be in the channel as a result of the given mapping being
    // unlinked.
    private async partUnlinkedIrcClients(req: ProvisionRequest, roomId: string, server: IrcServer, ircChannel: string) {
        // Get the full set of room IDs linked to this #channel
        const matrixRooms = await this.ircBridge.getStore().getMatrixRoomsForChannel(
            server, ircChannel
        );
        // make sure the unlinked room exists as we may have just removed it
        let exists = false;
        for (let i = 0; i < matrixRooms.length; i++) {
            if (matrixRooms[i].getId() === roomId) {
                exists = true;
                break;
            }
        }
        if (!exists) {
            matrixRooms.push(new MatrixRoom(roomId));
        }


        // For each room, get the list of real matrix users and tally up how many times each one
        // appears as joined
        const joinedUserCounts: {[userId: string]: number} = {}; // user_id => Number
        const unlinkedUserIds: string[] = [];
        const asBot = this.ircBridge.getAppServiceBridge().getBot();
        for (let i = 0; i < matrixRooms.length; i++) {
            let stateEvents = [];
            try {
                stateEvents = await asBot.getClient().roomState(matrixRooms[i].getId());
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

    private async leaveMatrixVirtuals(req: ProvisionRequest, roomId: string, server: IrcServer) {
        const asBot = this.ircBridge.getAppServiceBridge().getBot();
        const roomChannels = await this.ircBridge.getStore().getIrcChannelsForRoomId(
            roomId
        );
        if (roomChannels.length > 0) {
            req.log.warn(
                `Not leaving matrix virtuals from room, room is still bridged to ${roomChannels.length} channel(s)`
            );
            // We can't determine who should and shouldn't be in the room.
            return;
        }
        const stateEvents = await asBot.getClient().roomState(roomId);
        const roomInfo = await asBot.getRoomInfo(roomId, {
            state: {
                events: stateEvents
            }
        });
        req.log.info(`Leaving ${roomInfo.remoteJoinedUsers.length} virtual users from ${roomId}.`);
        this.ircBridge.getMemberListSyncer(server).addToLeavePool(
            roomInfo.remoteJoinedUsers,
            roomId
        );
    }

    // Cause the bot to leave the matrix room if there are no other channels being mapped to
    // this room
    private async leaveMatrixRoomIfUnprovisioned(req: ProvisionRequest, roomId: string) {
        const ircChannels = await this.ircBridge.getStore().getIrcChannelsForRoomId(roomId);
        if (ircChannels.length === 0) {
            const matrixClient = this.ircBridge.getAppServiceBridge()
                .getClientFactory().getClientAs();
            req.log.info(`Leaving room ${roomId} as there are no more provisioned mappings`);
            await matrixClient.leave(roomId);
        }
    }

    // List all mappings currently provisioned with the given matrix_room_id
    public listings(req: ProvisionRequest) {
        const roomId = req.params.roomId;
        try {
            this.roomIdValidator.validate({"matrix_room_id": roomId});
        }
        catch (err) {
            if (err._validationErrors) {
                const s = err._validationErrors.map((e: {instanceContext: string})=>{
                    return `${e.instanceContext} is malformed`;
                }).join(', ');
                throw new Error(s);
            }
            else {
                log.error(err);
                // change the message and throw
                throw new Error('Malformed parameters');
            }
        }

        return this.ircBridge.getStore()
            .getProvisionedMappings(roomId)
            .map((entry) => {
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

    private getLimits() {
        const count = this.ircBridge.getStore().getRoomCount();
        const limit = this.ircBridge.config.ircService.provisioning?.roomLimit || false;
        return {
            count,
            limit,
        };
    }
}
