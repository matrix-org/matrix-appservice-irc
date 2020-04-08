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

import { getLogger } from "../logging";
import { QueuePool } from "../util/QueuePool";
import Bluebird from "bluebird";
import { BridgeRequest } from "../models/BridgeRequest";
import { IrcClientConfig } from "../models/IrcClientConfig";
import { IrcServer } from "../irc/IrcServer";
import { PrometheusMetrics, MatrixUser, MatrixRoom } from "matrix-appservice-bridge";
import { BridgedClient } from "./BridgedClient";
import { IrcBridge } from "../bridge/IrcBridge";
import { IdentGenerator } from "./IdentGenerator";
import { Ipv6Generator } from "./Ipv6Generator";
import { IrcEventBroker } from "./IrcEventBroker";
import { DataStore } from "../datastore/DataStore";
const log = getLogger("ClientPool");

interface ReconnectionItem {
    cli: BridgedClient;
    chanList: string[];
}

/*
 * Maintains a lookup of connected IRC clients. These connections are transient
 * and may be closed for a variety of reasons.
 */
export class ClientPool {
    private botClients: { [serverDomain: string]: BridgedClient|undefined};
    private virtualClients: { [serverDomain: string]: {
        nicks: { [nickname: string]: BridgedClient|undefined};
        userIds: { [userId: string]: BridgedClient|undefined};
        pending: { [nick: string]: BridgedClient};
    };};
    private virtualClientCounts: { [serverDomain: string]: number };
    private reconnectQueues: { [serverDomain: string]: QueuePool<ReconnectionItem> };
    private identGenerator: IdentGenerator;
    private ipv6Generator: Ipv6Generator;
    private ircEventBroker: IrcEventBroker;
    constructor(private ircBridge: IrcBridge, private store: DataStore) {
        // The list of bot clients on servers (not specific users)
        this.botClients = { };

        // list of virtual users on servers
        this.virtualClients = { };

        // map of numbers of connected clients on each server
        // Counting these is quite expensive because we have to
        // ignore entries where the value is undefined. Instead,
        // just keep track of how many we have.
        this.virtualClientCounts = { };

        this.reconnectQueues = { };

        this.identGenerator = new IdentGenerator(store);
        this.ipv6Generator = new Ipv6Generator(store);
        this.ircEventBroker = new IrcEventBroker(
            this.ircBridge.getAppServiceBridge(),
            this,
            this.ircBridge.ircHandler,
        );
    }

    public nickIsVirtual(server: IrcServer, nick: string): boolean {
        if (!this.virtualClients[server.domain]) {
            return false;
        }

        if (this.getBridgedClientByNick(server, nick)) {
            return true;
        }

        // The client may not have signalled to us that it's connected, but it is connect*ing*.
        const pending = Object.keys(this.virtualClients[server.domain].pending || {});
        return pending.includes(nick);
    }

    public killAllClients(): Bluebird<void[]> {
        const domainList = Object.keys(this.virtualClients);
        let clients: (BridgedClient|undefined)[] = [];
        domainList.forEach((domain) => {
            clients = clients.concat(
                Object.keys(this.virtualClients[domain].nicks).map(
                    (nick: string) => this.virtualClients[domain].nicks[nick]
                )
            );

            clients = clients.concat(
                Object.keys(this.virtualClients[domain].userIds).map(
                    (userId: string) => this.virtualClients[domain].userIds[userId]
                )
            );

            clients.push(this.botClients[domain]);
        });

        const safeClients = clients.filter((c) => Boolean(c)) as BridgedClient[];

        return Bluebird.all(
            safeClients.map(
                (client) => client.kill()
            )
        );
    }

    public getOrCreateReconnectQueue(server: IrcServer) {
        if (server.getConcurrentReconnectLimit() === 0) {
            return null;
        }
        let q = this.reconnectQueues[server.domain];
        if (q === undefined) {
            q = this.reconnectQueues[server.domain] = new QueuePool(
                server.getConcurrentReconnectLimit(),
                (item) => {
                    log.info(`Reconnecting client. ${q.waitingItems} left.`);
                    return this.reconnectClient(item);
                }
            );
        }
        return q;
    }

    public setBot(server: IrcServer, client: BridgedClient) {
        this.botClients[server.domain] = client;
    }

    public getBot(server: IrcServer) {
        return this.botClients[server.domain];
    }

    public async loginToServer(server: IrcServer): Promise<BridgedClient> {
        const uname = "matrixirc";
        let bridgedClient = this.getBridgedClientByNick(server, uname);
        if (!bridgedClient) {
            const botIrcConfig = server.createBotIrcClientConfig(uname);
            bridgedClient = this.createIrcClient(botIrcConfig, null, true);
            log.debug(
                "Created new bot client for %s : %s (bot enabled=%s)",
                server.domain, bridgedClient.id, server.isBotEnabled()
            );
        }
        let chansToJoin: string[] = [];
        if (server.isBotEnabled()) {
            if (server.shouldJoinChannelsIfNoUsers()) {
                chansToJoin = await this.store.getTrackedChannelsForServer(server.domain);
            }
            else {
                chansToJoin = await this.ircBridge.getMemberListSyncer(server).getChannelsToJoin();
            }
        }
        log.info("Bot connecting to %s (%s channels) => %s",
            server.domain, chansToJoin.length, JSON.stringify(chansToJoin)
        );
        try {
            await bridgedClient.connect();
        }
        catch (err) {
            log.error("Bot failed to connect to %s : %s - Retrying....",
                server.domain, JSON.stringify(err));
            return this.loginToServer(server);
        }
        this.setBot(server, bridgedClient);
        let num = 1;
        chansToJoin.forEach((c: string) => {
            // join a channel every 500ms. We stagger them like this to
            // avoid thundering herds
            setTimeout(() => {
                if (!bridgedClient) { // For types.
                    return;
                }
                // catch this as if this rejects it will hard-crash
                // since this is a new stack frame which will bubble
                // up as an uncaught exception.
                bridgedClient.joinChannel(c).catch((e) => {
                    log.error("Failed to join channel:: %s", c);
                    log.error(e);
                });
            }, 500 * num);
            num += 1;
        });
        return bridgedClient;
    }

    /**
     * Get a {@link BridgedClient} instance. This will either return a cached instance
     * for the user, or create a new one.
     * @param server The IRC server for the IRC client.
     * @param userId The user_id associated with the connection.
     * @param displayName Displayname to set on the client.
     */
    public async getBridgedClient(server: IrcServer, userId: string, displayName?: string) {
        let bridgedClient = this.getBridgedClientByUserId(server, userId);
        if (bridgedClient) {
            log.debug("Returning cached bridged client %s", userId);
            return bridgedClient;
        }

        const mxUser = new MatrixUser(userId);
        if (displayName) {
            mxUser.setDisplayName(displayName);
        }

        // check the database for stored config information for this irc client
        // including username, custom nick, nickserv password, etc.
        let ircClientConfig: IrcClientConfig;
        const storedConfig = await this.store.getIrcClientConfig(userId, server.domain);
        if (storedConfig) {
            log.debug("Configuring IRC user from store => " + storedConfig);
            ircClientConfig = storedConfig;
        } else {
            ircClientConfig = IrcClientConfig.newConfig(
                mxUser, server.domain
            );
        }

        // recheck the cache: We just await'ed to check the client config. We may
        // be racing with another request to getBridgedClient.
        bridgedClient = this.getBridgedClientByUserId(server, userId);
        if (bridgedClient) {
            log.debug("Returning cached bridged client %s", userId);
            return bridgedClient;
        }

        log.debug(
            "Creating virtual irc user with nick %s for %s (display name %s)",
            ircClientConfig.getDesiredNick(), userId, displayName
        );
        try {
            bridgedClient = this.createIrcClient(ircClientConfig, mxUser, false);
            await bridgedClient.connect();
            if (!storedConfig) {
                await this.store.storeIrcClientConfig(ircClientConfig);
            }
            return bridgedClient;
        }
        catch (err) {
            if (bridgedClient) {
                // Remove client if we failed to connect!
                this.removeBridgedClient(bridgedClient);
            }
            // If we failed to connect
            log.error("Couldn't connect virtual user %s (%s) to %s : %s",
                    ircClientConfig.getDesiredNick(), userId, server.domain, JSON.stringify(err));
            throw err;
        }
    }

    private createBridgedClient(ircClientConfig: IrcClientConfig, matrixUser: MatrixUser|null, isBot: boolean) {
        const server = this.ircBridge.getServer(ircClientConfig.getDomain());
        if (server === null) {
            throw Error(
                "Cannot create bridged client for unknown server " +
                ircClientConfig.getDomain()
            );
        }

        if (matrixUser) { // Don't bother with the bot user
            const excluded = server.isExcludedUser(matrixUser.userId);
            if (excluded) {
                throw Error("Cannot create bridged client - user is excluded from bridging");
            }
        }

        if (!this.identGenerator) {
            throw Error("No ident generator configured");
        }

        if (!this.ipv6Generator) {
            throw Error("No ipv6 generator configured");
        }

        return new BridgedClient(
            server, ircClientConfig, matrixUser || undefined, isBot,
            this.ircEventBroker, this.identGenerator, this.ipv6Generator
        );
    }

    public createIrcClient(ircClientConfig: IrcClientConfig, matrixUser: MatrixUser|null, isBot: boolean) {
        const bridgedClient = this.createBridgedClient(
            ircClientConfig, matrixUser, isBot
        );
        const server = bridgedClient.server;

        if (this.virtualClients[server.domain] === undefined) {
            this.virtualClients[server.domain] = {
                nicks: Object.create(null),
                userIds: Object.create(null),
                pending: {},
            };
            this.virtualClientCounts[server.domain] = 0;
        }
        if (isBot) {
            this.botClients[server.domain] = bridgedClient;
        }

        // `pending` is used to ensure that we know if a nick belongs to a userId
        // before they have been connected. It's impossible to know for sure
        // what nick they will be assigned before being connected, but this
        // should catch most cases. Knowing the nick is important, because
        // slow clients may not send a 'client-connected' signal before a join is
        // emitted, which means ghost users may join with their nickname into matrix.
        this.virtualClients[server.domain].pending[bridgedClient.nick] = bridgedClient;

        // add event listeners
        bridgedClient.on("client-connected", this.onClientConnected.bind(this));
        bridgedClient.on("client-disconnected", this.onClientDisconnected.bind(this));
        bridgedClient.on("nick-change", this.onNickChange.bind(this));
        bridgedClient.on("join-error", this.onJoinError.bind(this));
        bridgedClient.on("irc-names", this.onNames.bind(this));

        // If the client is in the middle of changing nick, we might see IRC messages
        // come in that reference the new nick. In order to avoid duplicates, add a "pending"
        // nick in the bucket tempoarily.
        bridgedClient.on("pending-nick.add", (pendingNick) => {
            this.virtualClients[server.domain].pending[pendingNick] = bridgedClient;
        });
        bridgedClient.on("pending-nick.remove", (pendingNick) => {
            delete this.virtualClients[server.domain].pending[pendingNick];
        });

        // store the bridged client immediately in the pool even though it isn't
        // connected yet, else we could spawn 2 clients for a single user if this
        // function is called quickly.
        this.virtualClients[server.domain].userIds[bridgedClient.userId as string] = bridgedClient;
        this.virtualClientCounts[server.domain] = this.virtualClientCounts[server.domain] + 1;

        // Does this server have a max clients limit? If so, check if the limit is
        // reached and start cycling based on oldest time.
        this.checkClientLimit(server);
        return bridgedClient;
    }

    public getBridgedClientByUserId(server: IrcServer, userId: string) {
        if (!this.virtualClients[server.domain]) {
            return undefined;
        }
        const cli = this.virtualClients[server.domain].userIds[userId];
        if (!cli || cli.isDead()) {
            return undefined;
        }
        return cli;
    }

    public getBridgedClientByNick(server: IrcServer, nick: string) {
        const bot = this.getBot(server);
        if (bot && bot.nick === nick) {
            return bot;
        }

        if (!this.virtualClients[server.domain]) {
            return undefined;
        }
        const cli = this.virtualClients[server.domain].nicks[nick];
        if (cli?.isDead()) {
            return undefined;
        }
        return cli;
    }

    public getBridgedClientsForUserId(userId: string): BridgedClient[] {
        const domainList = Object.keys(this.virtualClients);
        const clientList: BridgedClient[] = [];
        domainList.forEach((domain) => {
            const cli = this.virtualClients[domain].userIds[userId];
            if (cli && !cli.isDead()) {
                clientList.push(cli);
            }
        });
        return clientList;
    }

    public getBridgedClientsForRegex(userIdRegexString: string) {
        const userIdRegex = new RegExp(userIdRegexString);
        const domainList = Object.keys(this.virtualClients);
        const clientList: {[userId: string]: BridgedClient[]} = {};
        domainList.forEach((domain) => {
            Object.keys(
                this.virtualClients[domain].userIds
            ).filter(
                (u) => userIdRegex.exec(u) !== null
            ).forEach((userId: string) => {
                if (!clientList[userId]) {
                    clientList[userId] = [];
                }
                const client = this.virtualClients[domain].userIds[userId];
                if (client) {
                    clientList[userId].push(client);
                }
            });
        });
        return clientList;
    }


    private async checkClientLimit(server: IrcServer) {
        if (server.getMaxClients() === 0) {
            return;
        }

        const numConnections = this.getNumberOfConnections(server);

        if (numConnections < server.getMaxClients()) {
            // under the limit, we're good for now.
            log.debug(
                "%s active connections on %s",
                numConnections, server.domain
            );
            return;
        }

        log.debug(
            "%s active connections on %s (limit %s)",
            numConnections, server.domain, server.getMaxClients()
        );

        // find the oldest client to kill.
        let oldest: BridgedClient|null = null;
        for (const client of Object.values(this.virtualClients[server.domain].nicks)) {
            if (!client) {
                // possible since undefined/null values can be present from culled entries
                continue;
            }
            if (client.isBot) {
                continue; // don't ever kick the bot off.
            }
            if (oldest === null) {
                oldest = client;
                continue;
            }
            if (client.getLastActionTs() < oldest.getLastActionTs()) {
                oldest = client;
            }
        }
        if (!oldest) {
            return;
        }
        // disconnect and remove mappings.
        this.removeBridgedClient(oldest);
        const domain = oldest.server.domain;
        try {
            await oldest.disconnect("limit_reached", `Client limit exceeded: ${server.getMaxClients()}`)
            log.info(`Client limit exceeded: Disconnected ${oldest.nick} on ${domain}.`);
        }
        catch (ex) {
            log.error(`Error when disconnecting ${oldest.nick} on server ${domain}: ${JSON.stringify(ex)}`);
        }
    }

    public countTotalConnections(): number {
        let count = 0;

        Object.keys(this.virtualClients).forEach((domain) => {
            const server = this.ircBridge.getServer(domain);
            if (server) {
                count += this.getNumberOfConnections(server);
            }
        });

        return count;
    }

    public totalReconnectsWaiting (serverDomain: string): number {
        if (this.reconnectQueues[serverDomain] !== undefined) {
            return this.reconnectQueues[serverDomain].waitingItems;
        }
        return 0;
    }

    public updateActiveConnectionMetrics(serverDomain: string, ageCounter: PrometheusMetrics.AgeCounters): void {
        if (this.virtualClients[serverDomain] === undefined) {
            return;
        }
        const clients = Object.values(this.virtualClients[serverDomain].userIds);
        clients.forEach((bridgedClient) => {
            if (!bridgedClient || bridgedClient.isDead()) {
                // We don't want to include dead ones, or ones that don't exist.
                return;
            }
            ageCounter.bump((Date.now() - bridgedClient.getLastActionTs()) / 1000);
        });
    }

    public getNickUserIdMappingForChannel(server: IrcServer, channel: string): {[nick: string]: string} {
        const nickUserIdMap: {[nick: string]: string} = {};
        const cliSet = this.virtualClients[server.domain].userIds;
        Object.keys(cliSet).filter((userId: string) => {
            if (!userId) {
                return false;
            }
            const cli = cliSet[userId];
            return cli && cli.chanList.includes(channel);
        }).forEach((userId: string) => {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            nickUserIdMap[cliSet[userId]!.nick] = userId;
        });
        // Correctly map the bot too.
        nickUserIdMap[server.getBotNickname()] = this.ircBridge.appServiceUserId;
        return nickUserIdMap;
    }

    public getConnectedMatrixUsersForServer(server: IrcServer): string[] {
        const users = this.virtualClients[server.domain];
        if (!users) {
            throw Error("Cannot get users for unknown server");
        }
        return Object.keys(users.userIds).filter((userId) => users.userIds[userId] !== null);
    }

    private getNumberOfConnections(server: IrcServer): number {
        if (!server || !this.virtualClients[server.domain]) { return 0; }
        return this.virtualClientCounts[server.domain];
    }

    private removeBridgedClient(bridgedClient: BridgedClient): void {
        const server = bridgedClient.server;
        if (bridgedClient.userId) {
            this.virtualClients[server.domain].userIds[bridgedClient.userId] = undefined;
        }
        this.virtualClients[server.domain].nicks[bridgedClient.nick] = undefined;
        this.virtualClientCounts[server.domain] = this.virtualClientCounts[server.domain] - 1;

        if (bridgedClient.isBot) {
            this.botClients[server.domain] = undefined;
        }
    }

    private onClientConnected(bridgedClient: BridgedClient): void {
        const server = bridgedClient.server;
        const oldNick = bridgedClient.nick;
        if (!bridgedClient.unsafeClient) {
            return;
        }
        const actualNick = bridgedClient.unsafeClient.nick;

        // remove the pending nick we had set for this user
        delete this.virtualClients[server.domain].pending[oldNick];

        // assign a nick to this client
        this.virtualClients[server.domain].nicks[actualNick] = bridgedClient;

        // informative logging
        if (oldNick !== actualNick) {
            log.debug("Connected with nick '%s' instead of desired nick '%s'",
                actualNick, oldNick);
        }
    }

    private async onClientDisconnected(bridgedClient: BridgedClient) {
        this.removeBridgedClient(bridgedClient);

        log.warn(`Client ${bridgedClient.id} disconnected with reason ${bridgedClient.disconnectReason}`);

        // remove the pending nick we had set for this user
        if (this.virtualClients[bridgedClient.server.domain]) {
            delete this.virtualClients[bridgedClient.server.domain].pending[bridgedClient.nick];
        }

        if (bridgedClient.disconnectReason === "banned" && bridgedClient.userId) {
            const req = new BridgeRequest(this.ircBridge.getAppServiceBridge().getRequestFactory().newRequest());
            this.ircBridge.matrixHandler.quitUser(
                req, bridgedClient.userId, [bridgedClient],
                null, "User was banned from the network"
            );
        }

        const isBot = bridgedClient.isBot;
        const chanList = bridgedClient.chanList;

        if (chanList.length === 0 && !isBot && bridgedClient.disconnectReason !== "iwanttoreconnect") {
            // Never drop the bot, or users that really want to reconnect.
            log.info(`Dropping ${bridgedClient.id} (${bridgedClient.nick}) because they are not joined to any channels`);
            return;
        }

        if (bridgedClient.explicitDisconnect) {
            log.info(`Dropping ${bridgedClient.id} (${bridgedClient.nick}) because explicitDisconnect is true`);
            // don't reconnect users which explicitly disconnected e.g. client
            // cycling, idle timeouts, leaving rooms, etc.
            return;
        }
        // Reconnect this user
        // change the client config to use the current nick rather than the desired nick. This
        // makes sure that the client attempts to reconnect with the *SAME* nick, and also draws
        // from the latest !nick change, as the client config here may be very very old.
        let cliConfig = bridgedClient.getClientConfig();
        if (bridgedClient.userId) {
            // We may have changed something between connections, so use the new config.
            const newConfig = await this.store.getIrcClientConfig(bridgedClient.userId, bridgedClient.server.domain);
            if (newConfig) {
                cliConfig = newConfig;
            }
        }

        cliConfig.setDesiredNick(bridgedClient.nick);
        const cli = this.createIrcClient(
            cliConfig, bridgedClient.matrixUser || null, bridgedClient.isBot
        );
        // remove ref to the disconnected client so it can be GC'd. If we don't do this,
        // the timeout below holds it in a closure, preventing it from being GC'd.
        (bridgedClient as unknown) = undefined;

        const queue = this.getOrCreateReconnectQueue(cli.server);
        if (queue === null) {
            this.reconnectClient({
                cli: cli,
                chanList: chanList,
            });
            return;
        }
        queue.enqueue(cli.id, {
            cli: cli,
            chanList: chanList,
        });
    }

    private async reconnectClient(cliChan: ReconnectionItem) {
        try {
            await cliChan.cli.reconnect(cliChan.chanList);
        }
        catch (ex) {
            log.error(
                "Failed to reconnect %s@%s", cliChan.cli.nick, cliChan.cli.server.domain
            );
        }
    }

    private onNickChange(bridgedClient: BridgedClient, oldNick: string, newNick: string): void {
        this.virtualClients[bridgedClient.server.domain].nicks[oldNick] = undefined;
        this.virtualClients[bridgedClient.server.domain].nicks[newNick] = bridgedClient;
    }

    private async onJoinError (bridgedClient: BridgedClient, chan: string, err: string): Promise<void> {
        const errorsThatShouldKick = [
            "err_bannedfromchan", // they aren't allowed in channels they are banned on.
            "err_inviteonlychan", // they aren't allowed in invite only channels
            "err_channelisfull", // they aren't allowed in if the channel is full
            "err_badchannelkey", // they aren't allowed in channels with a bad key
            "err_needreggednick", // they aren't allowed in +r channels if they haven't authed
        ];
        if (!errorsThatShouldKick.includes(err)) {
            return;
        }
        const userId = bridgedClient.userId;
        if (!userId || bridgedClient.isBot) {
            return; // the bot itself can get these join errors
        }
        // TODO: this is a bit evil, no one in their right mind would expect
        // the client pool to be kicking matrix users from a room :(
        log.info(`Kicking ${userId} from room due to ${err}`);
        const matrixRooms = await this.ircBridge.getStore().getMatrixRoomsForChannel(
            bridgedClient.server, chan
        );
        const promises = matrixRooms.map((room: MatrixRoom) => {
            return this.ircBridge.getAppServiceBridge().getIntent().kick(
                room.getId(), userId, `IRC error on ${chan}: ${err}`
            );
        });
        await Promise.all(promises);
    }

    private onNames(bridgedClient: BridgedClient, chan: string, names: {[key: string]: string}): Bluebird<void> {
        const mls = this.ircBridge.getMemberListSyncer(bridgedClient.server);
        if (!mls) {
            return Bluebird.resolve();
        }
        return Bluebird.cast(mls.updateIrcMemberList(chan, names));
    }
}
