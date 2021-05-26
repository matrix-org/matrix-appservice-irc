import { IrcBridge } from "./IrcBridge";
import { Queue } from "../util/Queue";
import { RoomAccessSyncer } from "./RoomAccessSyncer";
import { IrcServer, MembershipSyncKind } from "../irc/IrcServer";
import { BridgeRequest, BridgeRequestErr } from "../models/BridgeRequest";
import { BridgedClient } from "../irc/BridgedClient";
import { MatrixRoom, MatrixUser, MembershipQueue } from "matrix-appservice-bridge";
import { IrcUser } from "../models/IrcUser";
import { IrcAction } from "../models/IrcAction";
import { IrcRoom } from "../models/IrcRoom";
import { MatrixAction } from "../models/MatrixAction";
import { RequestLogger } from "../logging";
import { RoomOrigin } from "../datastore/DataStore";
import QuickLRU from "quick-lru";
import { IrcMessage } from "../irc/ConnectionInstance";
import { trackChannelAndCreateRoom } from "../bridge/RoomCreation";
const NICK_USERID_CACHE_MAX = 512;
const PM_POWERLEVEL_MATRIXUSER = 10;
const PM_POWERLEVEL_IRCUSER = 100;
const MEMBERSHIP_INITIAL_TTL_MS = 30 * 60 * 1000; // 30 mins
const PM_ROOM_CREATION_RETRIES = 3; // How often to retry to create a PM room, if it fails?

export type MatrixMembership = "join"|"invite"|"leave"|"ban";

interface RoomIdtoPrivateMember {
    [roomId: string]: {
        sender: string;
        membership: MatrixMembership;
    };
}

interface TopicQueueItem {
    matrixUser: MatrixUser;
    req: BridgeRequest;
    topic: string;
    matrixRooms: MatrixRoom[];
}

export interface IrcHandlerConfig {
    mapIrcMentionsToMatrix?: "on"|"off"|"force-off";
    powerLevelGracePeriodMs?: number;
}

type MetricNames = "join.names"|"join"|"part"|"pm"|"invite"|"topic"|"message"|"kick"|"mode";


export class IrcHandler {
    // maintain a map of which user ID is in which PM room, so we know if we
    // need to re-invite them if they bail.
    private readonly roomIdToPrivateMember: RoomIdtoPrivateMember = {};

    // Use per-channel queues to keep the setting of topics in rooms atomic in
    // order to prevent races involving several topics being received from IRC
    // in quick succession. If `(server, channel, topic)` are the same, an
    // existing promise will be used, otherwise a new item is added to the queue.
    private readonly topicQueues: {[channel: string]: Queue<TopicQueueItem>} = {};

    // A map of promises that resolve to the PM room that has been created for the
    // two users in the key. The $fromUserId is the user ID of the virtual IRC user
    // and the $toUserId, the user ID of the recipient of the message. This is used
    // to prevent races when many messages are sent as PMs at once and therefore
    // prevent many pm rooms from being created.
    private readonly pmRoomPromises: {[fromToUserId: string]: Promise<MatrixRoom>} = {};
    private readonly nickUserIdMapCache: QuickLRU<string, {[nick: string]: string}> = new QuickLRU({
        maxSize: NICK_USERID_CACHE_MAX,
    }); // server:channel => mapping

    /*
    One of:
    "on" - Defaults to enabled, users can choose to disable.
    "off" - Defaults to disabled, users can choose to enable.
    "force-off" - Disabled, cannot be enabled.
    */
    private mentionMode: "on"|"off"|"force-off";

    public readonly roomAccessSyncer: RoomAccessSyncer;

    private readonly roomBlockedSet = new Set<string>();

    private callCountMetrics?: {
        [key in MetricNames]: number;
    };
    private registeredNicks: {[userId: string]: boolean} = {};

    constructor (
        private readonly ircBridge: IrcBridge,
        config: IrcHandlerConfig = {},
        private readonly membershipQueue: MembershipQueue) {
        this.roomAccessSyncer = new RoomAccessSyncer(ircBridge);
        this.mentionMode = config.mapIrcMentionsToMatrix || "on";
        this.getMetrics();
    }

    public onMatrixMemberEvent(event: {room_id: string; state_key: string; content: {membership: MatrixMembership}}) {
        const priv = this.roomIdToPrivateMember[event.room_id];
        if (!priv) {
            // _roomIdToPrivateMember only starts tracking AFTER one private message
            // has been sent since the bridge started, so if we can't find it, no
            // messages have been sent so we can ignore it (since when we DO start
            // tracking we hit room state explicitly).
            return;
        }
        if (priv.sender !== event.state_key) {
            return; // don't care about member changes for other users
        }

        priv.membership = event.content.membership;
    }

    private async ensureMatrixUserJoined(roomId: string, userId: string, virtUserId: string, log: RequestLogger) {
        const intent = this.ircBridge.getAppServiceBridge().getIntent(virtUserId);
        let priv = this.roomIdToPrivateMember[roomId];
        if (!priv) {
            // create a brand new entry for this user. Set them to not joined initially
            // since we'll be yielding in a moment and we assume not joined.
            priv = {
                sender: userId,
                membership: "leave"
            };

            // query room state to see if the user is actually joined.
            log.debug("Querying PM room state (%s) between %s and %s",
                roomId, userId, virtUserId);
            const result = (await intent.getStateEvent(roomId, "m.room.member", userId, true));
            if (result) {
                priv = result;
            }
            this.roomIdToPrivateMember[roomId] = priv;
        }


        // we should have the latest membership state now for this user (either we just
        // fetched it or it has been kept in sync via onMatrixMemberEvent calls)

        if (priv.membership !== "join" && priv.membership !== "invite") {
            log.info("Inviting %s to the existing PM room with %s (current membership=%s)",
                userId, virtUserId, priv.membership);
            // We have to send a state event to ensure they get an is_direct.
            await intent.sendStateEvent(roomId, "m.room.member", userId, {
                membership: "invite",
                is_direct: true,
            });
            // this should also be echoed back to us via onMatrixMemberEvent but hey,
            // let's do this now as well.
            priv.membership = "invite";
        }
    }

    /**
     * Create a new matrix PM room for an IRC user with nick `fromUserNick` and another
     * matrix user with user ID `toUserId`.
     * @param req An associated request for contextual logging.
     * @param toUserId The user ID of the recipient.
     * @param fromUserId The user ID of the sender.
     * @param fromUserNick The nick of the sender.
     * @param server The sending IRC server.
     * @return A Promise which is resolved when the PM room has been created.
     */
    private async createPmRoom(
        req: BridgeRequest,
        toUserId: string,
        fromUserId: string,
        fromUserNick: string,
        server: IrcServer
    ): Promise<MatrixRoom> {
        let remainingReties = PM_ROOM_CREATION_RETRIES;
        let response;
        do {
            try {
                response = await this.ircBridge.getAppServiceBridge().getIntent(
                    fromUserId
                ).createRoom({
                    createAsClient: true,
                    options: {
                        name: (fromUserNick + " (PM on " + server.domain + ")"),
                        visibility: "private",
                        // We deliberately set our own power levels below.
                        // preset: "trusted_private_chat",
                        creation_content: {
                            "m.federate": server.shouldFederatePMs()
                        },
                        is_direct: true,
                        initial_state: [{
                            content: {
                                users: {
                                    [toUserId]: PM_POWERLEVEL_MATRIXUSER,
                                    [fromUserId]: PM_POWERLEVEL_IRCUSER,
                                },
                                events: {
                                    "m.room.avatar": 10,
                                    "m.room.name": 10,
                                    "m.room.canonical_alias": 100,
                                    "m.room.history_visibility": 100,
                                    "m.room.power_levels": 100,
                                    "m.room.encryption": 100
                                },
                                invite: 100,
                            },
                            type: "m.room.power_levels",
                            state_key: "",
                        }],
                    }
                });
            }
            catch (error) {
                req.log.error(error);
                req.log.warn(`Failed creating a PM room with ${toUserId}. Remaining reties: ${remainingReties}`);
            }
            remainingReties--;
        } while (!response && remainingReties > 0);
        if (!response) {
            throw Error(`Failed creating a PM room with ${toUserId}. Giving up.`);
        }
        const pmRoom = new MatrixRoom(response.room_id);
        const ircRoom = new IrcRoom(server, fromUserNick);

        await this.ircBridge.getStore().setPmRoom(
            ircRoom, pmRoom, toUserId, fromUserId
        );

        return pmRoom;
    }

    /**
     * Called when the AS receives an IRC message event.
     * @param {IrcServer} server The sending IRC server.
     * @param {IrcUser} fromUser The sender.
     * @param {IrcUser} toUser The target.
     * @param {Object} action The IRC action performed.
     * @return {Promise} which is resolved/rejected when the request
     * finishes.
     */
    public async onPrivateMessage(req: BridgeRequest, server: IrcServer, fromUser: IrcUser,
                                  toUser: IrcUser, action: IrcAction): Promise<BridgeRequestErr|void> {
        this.incrementMetric("pm");
        if (fromUser.isVirtual) {
            return BridgeRequestErr.ERR_VIRTUAL_USER;
        }

        if (!toUser.isVirtual) {
            req.log.error("Cannot route PM to %s", toUser);
            return BridgeRequestErr.ERR_DROPPED;
        }
        const bridgedIrcClient = this.ircBridge.getClientPool().getBridgedClientByNick(
            toUser.server, toUser.nick
        );
        if (!bridgedIrcClient) {
            req.log.error("Cannot route PM to %s - no client", toUser);
            return BridgeRequestErr.ERR_DROPPED;
        }
        req.log.info("onPrivateMessage: %s from=%s to=%s",
            server.domain, fromUser, toUser
        );
        req.log.debug("action=%s", JSON.stringify(action).substring(0, 80));

        if (bridgedIrcClient.isBot) {
            if (action.type !== "message") {
                req.log.debug("Ignoring non-message PM");
                return BridgeRequestErr.ERR_DROPPED;
            }
            req.log.debug("Rerouting PM directed to the bot from %s to provisioning", fromUser);
            this.ircBridge.getProvisioner().handlePm(server, fromUser, action.text);
            return undefined;
        }

        if (!server.allowsPms()) {
            req.log.error("Server %s disallows PMs.", server.domain);
            return BridgeRequestErr.ERR_DROPPED;
        }

        if (!bridgedIrcClient.userId) {
            req.log.error("Cannot route PM to %s - no user id on client", toUser);
            return BridgeRequestErr.ERR_DROPPED;
        }


        const mxAction = MatrixAction.fromIrcAction(action);

        if (!mxAction) {
            req.log.error("Couldn't map IRC action to matrix action");
            return BridgeRequestErr.ERR_DROPPED;
        }

        const virtualMatrixUser = await this.ircBridge.getMatrixUser(fromUser);
        req.log.debug(`Mapped ${fromUser.nick} -> ${virtualMatrixUser.getId()}`);

        // Try to get the room from the store.
        let pmRoom = await this.ircBridge.getStore().getMatrixPmRoom(
            bridgedIrcClient.userId, virtualMatrixUser.getId()
        );

        if (!pmRoom) {
            const pmRoomPromiseId = bridgedIrcClient.userId + ' ' + virtualMatrixUser.getId();
            const p = this.pmRoomPromises[pmRoomPromiseId];

            if (p) {
                try {
                    pmRoom = await p;
                }
                catch (ex) {
                    // it failed, so try to create a new one.
                    req.log.warn("Previous attempt to create room failed: %s", ex);
                    pmRoom = null;
                }
            }

            // If a promise to create this PM room does not already exist, create one
            if (!pmRoom) {
                req.log.info("Creating a PM room with %s", bridgedIrcClient.userId);
                this.pmRoomPromises[pmRoomPromiseId] = this.createPmRoom(
                    req, bridgedIrcClient.userId, virtualMatrixUser.getId(), fromUser.nick, server
                );
                pmRoom = await this.pmRoomPromises[pmRoomPromiseId];
            }
        }
        // make sure that the matrix user is (still) in the room
        try {
            await this.ensureMatrixUserJoined(
                pmRoom.getId(), bridgedIrcClient.userId, virtualMatrixUser.getId(), req.log
            );
        }
        catch (err) {
            // We still want to send the message into the room even if we can't check -
            // maybe the room state API has blown up.
            req.log.error(
                "Failed to ensure matrix user %s was joined to the PM room %s : %s",
                bridgedIrcClient.userId, pmRoom.getId(), err
            );
        }

        req.log.info("Relaying PM in room %s", pmRoom.getId());
        await this.ircBridge.sendMatrixAction(pmRoom, virtualMatrixUser, mxAction);
        return undefined;
    }

    /**
     * Called when the AS receives an IRC invite event.
     * @param {IrcServer} server The sending IRC server.
     * @param {IrcUser} fromUser The sender.
     * @param {IrcUser} toUser The target.
     * @param {String} channel The channel.
     * @return {Promise} which is resolved/rejected when the request
     * finishes.
     */
    public async onInvite (req: BridgeRequest, server: IrcServer, fromUser: IrcUser, toUser: IrcUser, channel: string) {
        this.incrementMetric("invite");
        if (fromUser.isVirtual) {
            return BridgeRequestErr.ERR_VIRTUAL_USER;
        }

        if (!toUser.isVirtual) {
            req.log.error("Cannot route invite to %s", toUser);
            return BridgeRequestErr.ERR_DROPPED;
        }

        const bridgedIrcClient = this.ircBridge.getClientPool().getBridgedClientByNick(
            toUser.server, toUser.nick
        );
        if (!bridgedIrcClient) {
            req.log.error("Cannot route invite to %s - no client", toUser);
            return BridgeRequestErr.ERR_DROPPED;
        }

        if (bridgedIrcClient.isBot) {
            req.log.info("Ignoring invite send to the bot");
            return BridgeRequestErr.ERR_DROPPED;
        }
        const ircClient = bridgedIrcClient;

        const virtualMatrixUser = await this.ircBridge.getMatrixUser(fromUser);
        req.log.debug("Mapped to %s", virtualMatrixUser.getId());
        const matrixRooms = await this.ircBridge.getStore().getMatrixRoomsForChannel(server, channel);
        const roomAlias = server.getAliasFromChannel(channel);
        const inviteIntent = this.ircBridge.getAppServiceBridge().getIntent(
            virtualMatrixUser.getId()
        );
        if (matrixRooms.length === 0) {
            const { mxRoom } = await trackChannelAndCreateRoom(
                this.ircBridge,
                req,
                {
                    origin: "join",
                    ircChannel: channel,
                    server: server,
                    inviteList: [],
                    roomAliasName: roomAlias.split(":")[0].substring(1),
                    intent: inviteIntent,
                }
            );
            matrixRooms.push(mxRoom);
        }

        const invitee = ircClient.userId;
        if (!invitee) {
            return BridgeRequestErr.ERR_DROPPED;
        }

        // send invite
        const invitePromises = matrixRooms.map((room) => {
            req.log.info(
                "Inviting %s to room %s", ircClient.userId, room.getId()
            );
            return this.ircBridge.getAppServiceBridge().getIntent(
                virtualMatrixUser.getId()
            ).invite(
                room.getId(), invitee
            );
        });
        await Promise.all(invitePromises);
        return undefined;
    }

    private async serviceTopicQueue (item: TopicQueueItem) {
        const promises = item.matrixRooms.map((matrixRoom) => {
            if (matrixRoom.topic === item.topic) {
                item.req.log.info(
                    "Topic of %s already set to '%s'",
                    matrixRoom.getId(),
                    item.topic
                );
                return Promise.resolve();
            }
            return this.ircBridge.getAppServiceBridge().getIntent(
                item.matrixUser.getId()
            ).setRoomTopic(
                matrixRoom.getId(), item.topic
            ).catch(() => {
                // Setter might not have powerlevels, trying again.
                return this.ircBridge.getAppServiceBridge().getIntent()
                    .setRoomTopic(matrixRoom.getId(), item.topic);
            }).then(
                () => {
                    matrixRoom.topic = item.topic;
                    return this.ircBridge.getStore().upsertMatrixRoom(matrixRoom);
                },
                (err) => {
                    item.req.log.error(`Error storing room ${matrixRoom.getId()} (${err.message})`);
                }
            );
        }
        );
        try {
            await Promise.all(promises);
            item.req.log.info(
                `Topic:  '${item.topic.substring(0, 20)}...' set in rooms: `,
                item.matrixRooms.map((matrixRoom) => matrixRoom.getId()).join(",")
            );
        }
        catch (err) {
            item.req.log.error(`Failed to set topic(s) ${err.message}`);
        }
    }

    /**
     * If configured, check to see if the all Matrix users in a given room are
     * joined to a channel. If they are not, drop the message.
     * @param req The IRC request
     * @param server The IRC server.
     */
    private async shouldRequireMatrixUserJoined(server: IrcServer, channel: string, roomId: string): Promise<boolean> {
        // The room state takes priority.
        const stateRequires =
            await this.ircBridge.roomConfigs.allowUnconnectedMatrixUsers(roomId, new IrcRoom(server, channel));
        if (stateRequires !== null) {
            return stateRequires;
        }
        return server.shouldRequireMatrixUserJoined(channel);
    }

    /**
     * See if every joined Matrix user is also joined to the IRC channel. If they are not,
     * this returns false. A seperate mechanism should be use to join the user if this fails.
     * @param req The IRC request
     * @param server The IRC server
     * @param channel The IRC channel
     * @param roomId The Matrix room
     * @returns True if all users are connected and joined, or false otherwise.
     */
    private async areAllMatrixUsersJoined(
        req: BridgeRequest, server: IrcServer, channel: string, roomId: string): Promise<boolean> {
        // Look for all the Matrix users in the room.
        const members = await this.ircBridge.getMatrixUsersForRoom(roomId);
        const pool = this.ircBridge.getClientPool();
        for (const userId of members) {
            if (userId === this.ircBridge.appServiceUserId) {
                continue;
            }
            const client = pool.getBridgedClientByUserId(server, userId);
            if (!client) {
                req.log.warn(`${userId} has not connected to IRC yet, not bridging message`);
                return false;
            }
            if (!client.inChannel(channel)) {
                // TODO: Should we poke them into joining?
                req.log.warn(`${userId} has not joined the channel yet, not bridging message`);
                return false;
            }
        }
        return true;
    }

    /**
     * Send a `org.matrix.appservice-irc.connection` state event into the room when a channel
     * is blocked or unblocked. Subsequent calls with the same state will no-op.
     * @param req The IRC request
     * @param roomId The Matrix room
     * @param channel The IRC room
     * @param blocked Is the channel blocked
     * @returns A promise, but it will always resolve.
     */
    private async setBlockedStateInRoom(req: BridgeRequest, roomId: string, ircRoom: IrcRoom, blocked: boolean) {
        if (this.roomBlockedSet.has(ircRoom.getId()) === blocked) {
            return;
        }
        this.roomBlockedSet[blocked ? 'add' : 'delete'](ircRoom.getId());
        try {
            const intent = this.ircBridge.getAppServiceBridge().getIntent();
            // This is set *approximately* for when the room is unblocked, as we don't do when a new user joins.
            await intent.sendStateEvent(roomId, "org.matrix.appservice-irc.connection", ircRoom.getId(), {
                blocked,
            });
        }
        catch (ex) {
            req.log.warn(`Could not set org.matrix.appservice-irc.connection in room`, ex);
        }
    }


    /**
     * Called when the AS receives an IRC topic event.
     * @param {IrcServer} server The sending IRC server.
     * @param {IrcUser} fromUser The sender.
     * @param {string} channel The target channel.
     * @param {Object} action The IRC action performed.
     * @return {Promise} which is resolved/rejected when the request finishes.
     */
    public async onTopic (req: BridgeRequest, server: IrcServer, fromUser: IrcUser,
                          channel: string, action: IrcAction) {
        this.incrementMetric("topic");
        if (fromUser.isVirtual) {
            // Don't echo our topics back.
            return BridgeRequestErr.ERR_VIRTUAL_USER;
        }
        req.log.info("onTopic: %s from=%s to=%s ",
            server.domain, fromUser, channel
        );
        req.log.debug("action=%s", JSON.stringify(action).substring(0, 80));


        const ALLOWED_ORIGINS: RoomOrigin[] = ["join", "alias"];
        const topic = action.text;

        // Only bridge topics for rooms created by the bridge, via !join or an alias
        const entries = (await this.ircBridge.getStore().getMappingsForChannelByOrigin(
            server, channel, ALLOWED_ORIGINS, true
        ));
        const matrixRooms = entries.filter((e) => e.matrix).map((e) => e.matrix) as MatrixRoom[];
        if (matrixRooms.length === 0) {
            req.log.info(
                "No mapped matrix rooms for IRC channel %s with origin = [%s]",
                channel,
                ALLOWED_ORIGINS
            );
            return BridgeRequestErr.ERR_NOT_MAPPED;
        }

        req.log.info(
            "New topic in %s - bot queing to set topic in %s",
            channel,
            matrixRooms.map((e) => e.getId())
        );

        const matrixUser = new MatrixUser(
            server.getUserIdFromNick(fromUser.nick)
        );

        if (!this.topicQueues[channel]) {
            this.topicQueues[channel] = new Queue(this.serviceTopicQueue.bind(this));
        }
        await this.topicQueues[channel].enqueue(
            server.domain + " " + channel + " " + topic,
            {req: req, matrixRooms, topic: topic, matrixUser}
        );
        return undefined;
    }

    /**
     * Called when the AS receives an IRC message event.
     * @param {IrcServer} server The sending IRC server.
     * @param {IrcUser} fromUser The sender.
     * @param {string} channel The target channel.
     * @param {Object} action The IRC action performed.
     * @return {Promise} which is resolved/rejected when the request finishes.
     */
    public async onMessage (req: BridgeRequest, server: IrcServer, fromUser: IrcUser,
                            channel: string, action: IrcAction) {
        this.incrementMetric("message");
        if (fromUser.isVirtual) {
            return BridgeRequestErr.ERR_VIRTUAL_USER;
        }

        const mxAction = MatrixAction.fromIrcAction(action);
        if (!mxAction) {
            req.log.error("Couldn't map IRC action to matrix action");
            return BridgeRequestErr.ERR_DROPPED;
        }

        req.log.info("onMessage: %s from=%s to=%s",
            server.domain, fromUser, channel
        );
        req.log.debug("action=%s", JSON.stringify(action).substring(0, 80))

        // Some setups require that we check all matrix users are joined before we bridge
        // messages.
        const matrixRooms = await Promise.all((
            await this.ircBridge.getStore().getMatrixRoomsForChannel(server, channel)
        ).filter(async (room) => {
            const required = await this.shouldRequireMatrixUserJoined(server, channel, room.roomId);
            req.log.debug(`${room.roomId} ${required ? "requires" : "does not require"} Matrix users to be joined`);
            if (required) {
                const blocked = await this.areAllMatrixUsersJoined(req, server, channel, room.roomId);
                // Do so asyncronously, as we don't want to block message handling on this.
                this.setBlockedStateInRoom(req, room.roomId, new IrcRoom(server, channel), blocked);
                return blocked;
            }
            return true;
        }));


        if (matrixRooms.length === 0) {
            req.log.info(
                "No mapped matrix rooms for IRC channel %s",
                channel
            );
            return undefined;
        }



        let mapping = null;
        if (this.nickUserIdMapCache.has(`${server.domain}:${channel}`)) {
            mapping = this.nickUserIdMapCache.get(`${server.domain}:${channel}`);
        }
        else if (this.mentionMode !== "force-off") {
            // Some users want to opt out of being mentioned.
            mapping = this.ircBridge.getClientPool().getNickUserIdMappingForChannel(
                server, channel
            );
            const store = this.ircBridge.getStore();
            const nicks = Object.keys(mapping);
            for (const nick of nicks) {
                if (nick === server.getBotNickname()) {
                    continue;
                }
                const userId = mapping[nick];
                const feature = (await store.getUserFeatures(userId)).mentions;
                const enabled = feature === true ||
                    (feature === undefined && this.mentionMode === "on");
                if (!enabled) {
                    delete mapping[nick];
                    // We MUST keep the userId in this mapping, because the user
                    // may enable the feature and we need to know which mappings
                    // need recalculating. This nick should hopefully never come
                    // up in the wild.
                    mapping["disabled-matrix-mentions-for-" + nick] = userId;
                }
            }
            this.nickUserIdMapCache.set(`${server.domain}:${channel}`, mapping);
        }

        if (mapping) {
            await mxAction.formatMentions(
                mapping,
                this.ircBridge.getAppServiceBridge().getIntent()
            );
        }

        const nickKey = server.domain + " " + fromUser.nick;
        let virtualMatrixUser: MatrixUser;
        if (this.registeredNicks[nickKey]) {
            // save the database hit
            const sendingUserId = server.getUserIdFromNick(fromUser.nick);
            virtualMatrixUser = new MatrixUser(sendingUserId);
        }
        else {
            virtualMatrixUser = await this.ircBridge.getMatrixUser(fromUser);
            this.registeredNicks[nickKey] = true;
        }

        const failed = [];
        req.log.debug(
            "Relaying in room(s) %s", matrixRooms.map((r) => r.getId()).join(", "),
        );
        for (const room of matrixRooms) {
            try {
                await this.ircBridge.sendMatrixAction(room, virtualMatrixUser, mxAction);
            }
            catch (ex) {
                // Check if it was a permission fail.
                // We can't check the `error` value because it's non-standard, so just assume a M_FORBIDDEN is a
                // PL related failure.
                if (ex.data?.errcode === "M_FORBIDDEN") {
                    req.log.warn(
                        `User ${virtualMatrixUser.getId()} may not have permission to post in ${room.getId()}`
                    );
                    this.roomAccessSyncer.onFailedMessage(req, server, channel);
                }
                // Do not fail the operation because a message failed, but keep track of the failures
                failed.push(Promise.reject(ex));
            }
        }
        // We still want the request to fail
        await Promise.all(failed);
        return undefined;
    }

    /**
     * Called when the AS receives an IRC join event.
     * @param {IrcServer} server The sending IRC server.
     * @param {IrcUser} joiningUser The user who joined.
     * @param {string} chan The channel that was joined.
     * @param {string} kind The kind of join (e.g. from a member list if
     * the bot just connected, or an actual JOIN command)
     * @return {Promise} which is resolved/rejected when the request finishes.
     */
    public async onJoin (req: BridgeRequest, server: IrcServer, joiningUser: IrcUser,
                         chan: string, kind: "names"|"join"|"nick") {
        if (kind === "names") {
            this.incrementMetric("join.names");
        }
        else { // Let's avoid any surprises
            this.incrementMetric("join");
        }

        this.invalidateNickUserIdMap(server, chan);

        req.log.info("onJoin(%s) %s to %s", kind, joiningUser.nick, chan);
        // if the person joining is a virtual IRC user, do nothing.
        if (joiningUser.isVirtual) {
            return BridgeRequestErr.ERR_VIRTUAL_USER;
        }

        const nick = joiningUser.nick;
        const syncType: MembershipSyncKind = kind === "names" ? "initial" : "incremental";
        if (!server.shouldSyncMembershipToMatrix(syncType, chan)) {
            req.log.debug("IRC onJoin(%s) %s to %s - not syncing.", kind, nick, chan);
            return BridgeRequestErr.ERR_NOT_MAPPED;
        }


        // get virtual matrix user
        const matrixUser = await this.ircBridge.getMatrixUser(joiningUser);
        const matrixRooms = await this.ircBridge.getStore().getMatrixRoomsForChannel(server, chan);
        const intent = this.ircBridge.getAppServiceBridge().getIntent(
            matrixUser.getId()
        );
        const promises = matrixRooms.map(async (room) => {
            req.log.info("Joining room %s and setting presence to online", room.getId());
            // Only retry if this is not an initial sync to avoid extra load
            const shouldRetry = syncType === "incremental";
            // Initial membership should have a longer TTL as it is likely going to be delayed by a large
            // number of new joiners.
            const ttl = syncType === "initial" ? MEMBERSHIP_INITIAL_TTL_MS : undefined;
            await this.membershipQueue.join(room.getId(), matrixUser.getId(), req, shouldRetry, ttl);
            intent.setPresence("online");
        });
        if (matrixRooms.length === 0) {
            req.log.info("No mapped matrix rooms for IRC channel %s", chan);
        }
        await Promise.all(promises);
        return undefined;
    }

    public async onKick (req: BridgeRequest, server: IrcServer, kicker: IrcUser,
                         kickee: IrcUser, chan: string, reason: string) {
        this.incrementMetric("kick");
        req.log.info(
            "onKick(%s) %s is kicking %s from %s",
            server.domain, kicker.nick, kickee.nick, chan
        );

        /*
        We know this is an IRC client kicking someone.
        There are 2 scenarios to consider here:
        - IRC on IRC kicking
        - IRC on Matrix kicking

        IRC-IRC
        =======
        __USER A____            ____USER B___
        |            |          |             |
        IRC       vMatrix1       IRC      vMatrix2 |     Effect
        -----------------------------------------------------------------------
        Kicker                 Kickee              |  vMatrix2 leaves room.
                                                    This avoid potential permission issues
                                                    in case vMatrix1 cannot kick vMatrix2
                                                    on Matrix.

        IRC-Matrix
        ==========
        __USER A____            ____USER B___
        |            |          |             |
        Matrix      vIRC        IRC       vMatrix  |     Effect
        -----------------------------------------------------------------------
                Kickee      Kicker              |  Bot tries to kick Matrix user via /kick.
        */

        if (kickee.isVirtual) {
            // A real IRC user is kicking one of us - this is IRC on Matrix kicking.
            const matrixRooms = await this.ircBridge.getStore().getMatrixRoomsForChannel(server, chan);
            if (matrixRooms.length === 0) {
                req.log.info("No mapped matrix rooms for IRC channel %s", chan);
                return;
            }
            const bridgedIrcClient = this.ircBridge.getClientPool().getBridgedClientByNick(
                server, kickee.nick
            );
            if (!bridgedIrcClient || bridgedIrcClient.isBot || !bridgedIrcClient.userId) {
                return; // unexpected given isVirtual === true, but meh, bail.
            }
            const userId = bridgedIrcClient.userId;
            await Promise.all(matrixRooms.map((room) =>
                this.membershipQueue.leave(
                    room.getId(), userId, req, true,
                    `${kicker.nick} has kicked this user from ${chan} (${reason})`, this.ircBridge.appServiceUserId)
            ));
        }
        else {
            // the kickee is just some random IRC user, but we still need to bridge this as IRC
            // will NOT send a PART command. We equally cannot make a fake PART command and
            // reuse the same code path as we want to force this to go through, regardless of
            // whether incremental join/leave syncing is turned on.
            const matrixUserKickee = await this.ircBridge.getMatrixUser(kickee);
            const matrixUserKicker = await this.ircBridge.getMatrixUser(kicker);
            req.log.info("Mapped kickee nick %s to %s", kickee.nick, JSON.stringify(matrixUserKickee));
            const matrixRooms = await this.ircBridge.getStore().getMatrixRoomsForChannel(server, chan);
            if (matrixRooms.length === 0) {
                req.log.info("No mapped matrix rooms for IRC channel %s", chan);
                return;
            }
            await Promise.all(matrixRooms.map(async (room) => {
                try {
                    await this.membershipQueue.leave(
                        room.getId(), matrixUserKickee.getId(), req, false, reason, matrixUserKicker.getId(),
                    );
                }
                catch (ex) {
                    const formattedReason = `Kicked by ${kicker.nick} ${reason ? ": " + reason : ""}`;
                    // We failed to show a real kick, so just leave.
                    await this.membershipQueue.leave(
                        room.getId(), matrixUserKickee.getId(), req, false, formattedReason,
                    );
                    // If this fails, we want to fail the operation.
                }
                try {
                    await this.roomAccessSyncer.setPowerLevel(room.getId(), matrixUserKickee.getId(), null, req);
                }
                catch (ex) {
                    // This is non-critical but annoying.
                    req.log.warn("Failed to remove power levels for leaving user.");
                }
            }));
        }
    }

    /**
     * Called when the AS receives an IRC part event.
     * @param server The sending IRC server.
     * @param leavingUser The user who parted.
     * @param chan The channel that was left.
     * @param kind The kind of part (e.g. PART, KICK, BAN, QUIT, netsplit, etc)
     * @param reason: The reason why the client parted, if given.
     * @return A promise which is resolved/rejected when the request finishes.
     */
    public async onPart (req: BridgeRequest, server: IrcServer, leavingUser: IrcUser,
                         chan: string, kind: string, reason?: string): Promise<BridgeRequestErr|undefined> {
        this.incrementMetric("part");
        this.invalidateNickUserIdMap(server, chan);
        // parts are always incremental (only NAMES are initial)
        if (!server.shouldSyncMembershipToMatrix("incremental", chan)) {
            req.log.debug("Server doesn't mirror parts.");
            return undefined;
        }
        const nick = leavingUser.nick;
        req.log.info("onPart(%s) %s to %s", kind, nick, chan);

        // if the person leaving is a virtual IRC user, do nothing. Unless it's a part.
        if (leavingUser.isVirtual && kind !== "part") {
            return BridgeRequestErr.ERR_VIRTUAL_USER;
        }

        const matrixRooms = await this.ircBridge.getStore().getMatrixRoomsForChannel(server, chan);
        if (matrixRooms.length === 0) {
            req.log.info("No mapped matrix rooms for IRC channel %s", chan);
            return BridgeRequestErr.ERR_NOT_MAPPED;
        }

        let userId: string;
        if (leavingUser.isVirtual) {
            const bridgedClient = this.ircBridge.getClientPool().getBridgedClientByNick(
                server, nick
            );
            if (!bridgedClient|| !bridgedClient.userId || !bridgedClient.inChannel(chan)) {
                req.log.info("Not kicking user from room, user is not in channel");
                // We don't need to send a leave to a channel we were never in.
                return BridgeRequestErr.ERR_DROPPED;
            }
            userId = bridgedClient.userId;
        }
        else {
            const matrixUser = await this.ircBridge.getMatrixUser(leavingUser);
            userId = matrixUser.userId;
        }

        // get virtual matrix user
        req.log.info("Mapped nick %s to %s (leaving %s room(s))", nick, userId, matrixRooms.length);
        await Promise.all(matrixRooms.map(async (room) => {
            if (leavingUser.isVirtual) {
                return this.membershipQueue.leave(
                    room.getId(), userId, req, true, this.ircBridge.appServiceUserId);
            }

            // Show a reason if the part is not a regular part, or reason text was given.
            const kindText = kind[0].toUpperCase() + kind.substring(1);
            if (reason) {
                reason = `${kindText}: ${reason}`;
            }
            else if (kind !== "part") {
                reason = kindText;
            }

            await this.membershipQueue.leave(
                room.getId(), userId, req, true, reason,
                leavingUser.isVirtual ? this.ircBridge.appServiceUserId : undefined);
            return this.roomAccessSyncer.setPowerLevel(room.getId(), userId, null, req);
        }));
        return undefined;
    }

    /**
     * Called when a user sets a mode in a channel.
     * @param {Request} req The metadata request
     * @param {IrcServer} server The sending IRC server.
     * @param {string} channel The channel that has the given mode.
     * @param {string} mode The mode that the channel is in, e.g. +sabcdef
     * @return {Promise} which is resolved/rejected when the request finishes.
     */
    public async onMode(req: BridgeRequest, server: IrcServer, channel: string, by: string,
                        mode: string, enabled: boolean, arg: string|null) {
        this.incrementMetric("mode");
        req.log.info(
            "onMode(%s) in %s by %s (arg=%s)",
            (enabled ? ("+" + mode) : ("-" + mode)),
            channel, by, arg
        );
        await this.roomAccessSyncer.onMode(req, server, channel, by, mode, enabled, arg);
    }

    /**
     * Called when channel mode information is received
     * @param {Request} req The metadata request
     * @param {IrcServer} server The sending IRC server.
     * @param {string} channel The channel that has the given mode.
     * @param {string} mode The mode that the channel is in, e.g. +sabcdef
     * @return {Promise} which is resolved/rejected when the request finishes.
     */
    public async onModeIs(req: BridgeRequest, server: IrcServer, channel: string, mode: string) {
        req.log.info(`onModeIs for ${channel} = ${mode}.`);
        await this.roomAccessSyncer.onModeIs(req, server, channel, mode);
    }

    /**
     * Called when the AS connects/disconnects a Matrix user to IRC.
     * @param {Request} req The metadata request
     * @param {BridgedClient} client The client who is acting on behalf of the Matrix user.
     * @param {string} msg The message to share with the Matrix user.
     * @param {boolean} force True if ignoring startup suppresion.
     * @param ircMsg Optional data about the metadata.
     * @return {Promise} which is resolved/rejected when the request finishes.
     */
    public async onMetadata(req: BridgeRequest, client: BridgedClient, msg: string, force: boolean,
                            ircMsg?: IrcMessage) {
        if (!client.userId) {
            // Probably the bot
            return undefined;
        }
        req.log.info("%s : Sending metadata '%s'", client, msg);
        if (!this.ircBridge.isStartedUp && !force) {
            req.log.info("Suppressing metadata: not started up.");
            return BridgeRequestErr.ERR_DROPPED;
        }

        const botUser = new MatrixUser(this.ircBridge.appServiceUserId);

        if (ircMsg?.command === "err_nosuchnick") {
            const otherNick = ircMsg.args[1];
            const otherUser = new MatrixUser(client.server.getUserIdFromNick(otherNick));
            const room = await this.ircBridge.getStore().getMatrixPmRoom(client.userId, otherUser.userId);
            if (room) {
                return this.ircBridge.sendMatrixAction(
                    room, otherUser, new MatrixAction(
                        "notice", `User is not online or does not exist. Message not sent.`
                    ),
                );
            }
            req.log.warn(`No existing PM found for ${client.userId} <--> ${otherUser.userId}`);
            // No room associated, fall through
        }


        let adminRoom: MatrixRoom;
        const fetchedAdminRoom = await this.ircBridge.getStore().getAdminRoomByUserId(client.userId);
        if (!fetchedAdminRoom) {
            req.log.info("Creating an admin room with %s", client.userId);
            const response = await this.ircBridge.getAppServiceBridge().getIntent().createRoom({
                createAsClient: false,
                options: {
                    name: `${client.server.getReadableName()} IRC Bridge status`,
                    topic:  `This room shows any errors or status messages from ` +
                            `${client.server.domain}, as well as letting you control ` +
                            "the connection. ",
                    preset: "trusted_private_chat",
                    visibility: "private",
                    invite: [client.userId]
                }
            });
            adminRoom = new MatrixRoom(response.room_id);
            await this.ircBridge.getStore().storeAdminRoom(adminRoom, client.userId);
            const newRoomMsg = `You've joined a Matrix room which is bridged to the IRC network ` +
                            `'${client.server.domain}', where you ` +
                            `are now connected as ${client.nick}. ` +
                            `This room shows any errors or status messages from IRC, as well as ` +
                            `letting you control the connection. Type !help for more information`

            const notice = new MatrixAction("notice", newRoomMsg);
            await this.ircBridge.sendMatrixAction(adminRoom, botUser, notice);
        }
        else {
            adminRoom = fetchedAdminRoom;
        }


        if (ircMsg?.command === "err_cannotsendtochan") {
            msg = `Message could not be sent to ${ircMsg.args[1]}`;
        }

        const notice = new MatrixAction("notice", msg);
        await this.ircBridge.sendMatrixAction(adminRoom, botUser, notice);
        return undefined;
    }


    public invalidateCachingForUserId(userId: string) {
        if (this.mentionMode === "force-off") {
            return false;
        }
        for (const kv of this.nickUserIdMapCache) {
            if (Object.values(kv[1]).includes(userId)) {
                this.nickUserIdMapCache.delete(kv[0]);
            }
        }
        return true;
    }

    public incrementMetric(metric: MetricNames) {
        if (!this.callCountMetrics) { return; /* for TS-safety, but this shouldn't happen */ }
        if (this.callCountMetrics[metric] === undefined) {
            this.callCountMetrics[metric] = 0;
        }
        this.callCountMetrics[metric]++;
    }

    public getMetrics() {
        const metrics = Object.assign({}, this.callCountMetrics);
        this.callCountMetrics = {
            "join.names": 0,
            "join": 0,
            "part": 0,
            "pm": 0,
            "invite": 0,
            "topic": 0,
            "message": 0,
            "kick": 0,
            "mode": 0,
        };
        return metrics;
    }

    public onConfigChanged(config: IrcHandlerConfig) {
        this.mentionMode = config.mapIrcMentionsToMatrix || "on";
    }

    private invalidateNickUserIdMap(server: IrcServer, channel: string) {
        this.nickUserIdMapCache.delete(`${server.domain}:${channel}`);
    }
}
