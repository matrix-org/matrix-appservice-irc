import { IrcBridge } from "./IrcBridge";
import { QuitDebouncer } from "./QuitDebouncer";
import { Queue } from "../util/Queue";
import { RoomAccessSyncer } from "./RoomAccessSyncer";
import { IrcServer, MembershipSyncKind } from "../irc/IrcServer";
import { BridgeRequest, BridgeRequestErr } from "../models/BridgeRequest";
import { BridgedClient } from "../irc/BridgedClient";
import { MatrixRoom, MatrixUser } from "matrix-appservice-bridge";
import { IrcUser } from "../models/IrcUser";
import { IrcAction } from "../models/IrcAction";
import { IrcRoom } from "../models/IrcRoom";
import { MatrixAction } from "../models/MatrixAction";
import { RequestLogger } from "../logging";
import { RoomOrigin } from "../datastore/DataStore";
import QuickLRU from "quick-lru";
import { MembershipQueue } from "../util/MembershipQueue";
import { IrcMessage } from "../irc/ConnectionInstance";

const NICK_USERID_CACHE_MAX = 512;

type MatrixMembership = "join"|"invite"|"leave"|"ban";

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
    leaveConcurrency?: number;
}

type MetricNames = "join.names"|"join"|"part"|"pm"|"invite"|"topic"|"message"|"kick"|"mode";

export class IrcHandler {
    // maintain a map of which user ID is in which PM room, so we know if we
    // need to re-invite them if they bail.
    private readonly roomIdToPrivateMember: RoomIdtoPrivateMember = {};

    private readonly quitDebouncer: QuitDebouncer;

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
    private readonly mentionMode: "on"|"off"|"force-off";

    public readonly roomAccessSyncer: RoomAccessSyncer;

    private callCountMetrics?: {
        [key in MetricNames]: number;
    };
    private registeredNicks: {[userId: string]: boolean} = {};

    constructor (
        private readonly ircBridge: IrcBridge,
        config: IrcHandlerConfig = {},
        private readonly membershipQueue: MembershipQueue) {
        this.quitDebouncer = new QuitDebouncer(ircBridge);
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
            this.roomIdToPrivateMember[roomId] = priv;

            // query room state to see if the user is actually joined.
            log.info("Querying PM room state (%s) between %s and %s",
                roomId, userId, virtUserId);
            priv = (await intent.getStateEvent(roomId, "m.room.member", userId));
            this.roomIdToPrivateMember[roomId] = priv;
        }


        // we should have the latest membership state now for this user (either we just
        // fetched it or it has been kept in sync via onMatrixMemberEvent calls)

        if (priv.membership !== "join" && priv.membership !== "invite") {
            log.info("Inviting %s to the existing PM room with %s (current membership=%s)",
                userId, virtUserId, priv.membership);
            await intent.invite(roomId, userId);
            // this should also be echoed back to us via onMatrixMemberEvent but hey,
            // let's do this now as well.
            priv.membership = "invite";
        }
    }

    /**
     * Create a new matrix PM room for an IRC user  with nick `fromUserNick` and another
     * matrix user with user ID `toUserId`.
     * @param {string} toUserId : The user ID of the recipient.
     * @param {string} fromUserId : The user ID of the sender.
     * @param {string} fromUserNick : The nick of the sender.
     * @param {IrcServer} server : The sending IRC server.
     * @return {Promise} which is resolved when the PM room has been created.
     */
    private async createPmRoom (toUserId: string, fromUserId: string, fromUserNick: string, server: IrcServer) {
        const response = await this.ircBridge.getAppServiceBridge().getIntent(
            fromUserId
        ).createRoom({
            createAsClient: true,
            options: {
                name: (fromUserNick + " (PM on " + server.domain + ")"),
                visibility: "private",
                preset: "trusted_private_chat",
                invite: [toUserId],
                creation_content: {
                    "m.federate": server.shouldFederatePMs()
                },
                is_direct: true,
            }
        });
        const pmRoom = new MatrixRoom(response.room_id);
        const ircRoom = new IrcRoom(server, fromUserNick);

        await this.ircBridge.getStore().setPmRoom(
            ircRoom, pmRoom, toUserId, fromUserId
        );

        return pmRoom;
    }

    /**
     * Called when the AS receives an IRC message event.
     * @param {IrcServer} server : The sending IRC server.
     * @param {IrcUser} fromUser : The sender.
     * @param {IrcUser} toUser : The target.
     * @param {Object} action : The IRC action performed.
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
        req.log.info("onPrivateMessage: %s from=%s to=%s action=%s",
            server.domain, fromUser, toUser,
            JSON.stringify(action).substring(0, 80)
        );

        if (bridgedIrcClient.isBot) {
            if (action.type !== "message") {
                req.log.info("Ignoring non-message PM");
                return BridgeRequestErr.ERR_DROPPED;
            }
            req.log.debug("Rerouting PM directed to the bot from %s to provisioning", fromUser);
            this.ircBridge.getProvisioner().handlePm(server, fromUser, action.text);
            return undefined;
        }

        if (!bridgedIrcClient.userId) {
            req.log.error("Cannot route PM to %s - no user id on client", toUser);
            return BridgeRequestErr.ERR_DROPPED;
        }

        if (!server.allowsPms()) {
            req.log.error("Server %s disallows PMs.", server.domain);
            return BridgeRequestErr.ERR_DROPPED;
        }

        const mxAction = MatrixAction.fromIrcAction(action);

        if (!mxAction) {
            req.log.error("Couldn't map IRC action to matrix action");
            return BridgeRequestErr.ERR_DROPPED;
        }

        const virtualMatrixUser = await this.ircBridge.getMatrixUser(fromUser);
        req.log.info("Mapped to %s", JSON.stringify(virtualMatrixUser));

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
                    bridgedIrcClient.userId, virtualMatrixUser.getId(), fromUser.nick, server
                );
                pmRoom = await this.pmRoomPromises[pmRoomPromiseId];
            }
        }
        else {
            // make sure that the matrix user is still in the room
            try {
                await this.ensureMatrixUserJoined(
                    pmRoom.getId(), bridgedIrcClient.userId, virtualMatrixUser.getId(), req.log
                );
            }
            catch (err) {
                // We still want to send the message into the room even if we can't check -
                // maybe the room state API has blown up.
                req.log.error(
                    "Failed to ensure matrix user %s was joined to the existing PM room %s : %s",
                    bridgedIrcClient.userId, pmRoom.getId(), err
                );
            }
        }

        req.log.info("Relaying PM in room %s", pmRoom.getId());
        await this.ircBridge.sendMatrixAction(pmRoom, virtualMatrixUser, mxAction);
        return undefined;
    }

    /**
     * Called when the AS receives an IRC invite event.
     * @param {IrcServer} server : The sending IRC server.
     * @param {IrcUser} fromUser : The sender.
     * @param {IrcUser} toUser : The target.
     * @param {String} channel : The channel.
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
        req.log.info("Mapped to %s", JSON.stringify(virtualMatrixUser));
        const matrixRooms = await this.ircBridge.getStore().getMatrixRoomsForChannel(server, channel);
        const roomAlias = server.getAliasFromChannel(channel);

        if (matrixRooms.length === 0) {
            const initialState: unknown[] = [
                {
                    type: "m.room.join_rules",
                    state_key: "",
                    content: {
                        join_rule: server.getJoinRule()
                    }
                },
                {
                    type: "m.room.history_visibility",
                    state_key: "",
                    content: {
                        history_visibility: "joined"
                    }
                }
            ];
            if (server.areGroupsEnabled()) {
                initialState.push({
                    type: "m.room.related_groups",
                    state_key: "",
                    content: {
                        groups: [server.getGroupId()]
                    }
                });
            }

            if (this.ircBridge.stateSyncer) {
                initialState.push(
                    this.ircBridge.stateSyncer.createInitialState(
                        server,
                        channel,
                    )
                )
            }
            const ircRoom = await this.ircBridge.trackChannel(server, channel);
            const response = await this.ircBridge.getAppServiceBridge().getIntent(
                virtualMatrixUser.getId()
            ).createRoom({
                options: {
                    room_alias_name: roomAlias.split(":")[0].substring(1), // localpart
                    name: channel,
                    visibility: "private",
                    preset: "public_chat",
                    creation_content: {
                        "m.federate": server.shouldFederate()
                    },
                    initial_state: initialState,
                }
            });

            // store the mapping
            const mxRoom = new MatrixRoom(response.room_id);
            await this.ircBridge.getStore().storeRoom(
                ircRoom, mxRoom, 'join'
            );

            // /mode the channel AFTER we have created the mapping so we process +s and +i correctly.
            this.ircBridge.publicitySyncer.initModeForChannel(
                server, channel
            ).catch(() => {
                req.log.error(
                    "Could not init mode channel %s on %s",
                    channel, server
                );
            });

            req.log.info(
                "Created a room to track %s on %s and invited %s",
                ircRoom.channel, server.domain, virtualMatrixUser.getId()
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
     * Called when the AS receives an IRC topic event.
     * @param {IrcServer} server : The sending IRC server.
     * @param {IrcUser} fromUser : The sender.
     * @param {string} channel : The target channel.
     * @param {Object} action : The IRC action performed.
     * @return {Promise} which is resolved/rejected when the request finishes.
     */
    public async onTopic (req: BridgeRequest, server: IrcServer, fromUser: IrcUser,
                          channel: string, action: IrcAction) {
        this.incrementMetric("topic");
        req.log.info("onTopic: %s from=%s to=%s action=%s",
            server.domain, fromUser, channel, JSON.stringify(action).substring(0, 80)
        );

        if (fromUser.isVirtual) {
            // Don't echo our topics back.
            return BridgeRequestErr.ERR_VIRTUAL_USER;
        }

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
     * @param {IrcServer} server : The sending IRC server.
     * @param {IrcUser} fromUser : The sender.
     * @param {string} channel : The target channel.
     * @param {Object} action : The IRC action performed.
     * @return {Promise} which is resolved/rejected when the request finishes.
     */
    public async onMessage (req: BridgeRequest, server: IrcServer, fromUser: IrcUser,
                            channel: string, action: IrcAction) {
        this.incrementMetric("message");
        if (fromUser.isVirtual) {
            return BridgeRequestErr.ERR_VIRTUAL_USER;
        }
        const matrixRooms = await this.ircBridge.getStore().getMatrixRoomsForChannel(server, channel);

        if (matrixRooms.length === 0) {
            req.log.info(
                "No mapped matrix rooms for IRC channel %s",
                channel
            );
            return undefined;
        }

        req.log.info("onMessage: %s from=%s to=%s action=%s",
            server.domain, fromUser, channel, JSON.stringify(action).substring(0, 80)
        );

        const mxAction = MatrixAction.fromIrcAction(action);
        if (!mxAction) {
            req.log.error("Couldn't map IRC action to matrix action");
            return BridgeRequestErr.ERR_DROPPED;
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

        const promises = [];
        for (const room of matrixRooms) {
            req.log.info(
                "Relaying in room %s", room.getId()
            );
            promises.push(
                this.ircBridge.sendMatrixAction(room, virtualMatrixUser, mxAction)
            );
        }
        await Promise.all(promises);
        return undefined;
    }

    /**
     * Called when the AS receives an IRC join event.
     * @param {IrcServer} server : The sending IRC server.
     * @param {IrcUser} joiningUser : The user who joined.
     * @param {string} chan : The channel that was joined.
     * @param {string} kind : The kind of join (e.g. from a member list if
     * the bot just connected, or an actual JOIN command)
     * @return {Promise} which is resolved/rejected when the request finishes.
     */
    public async onJoin (req: BridgeRequest, server: IrcServer, joiningUser: IrcUser,
                         chan: string, kind: string) {
        if (kind === "names") {
            this.incrementMetric("join.names");
        }
        else { // Let's avoid any surprises
            this.incrementMetric("join");
        }

        this.invalidateNickUserIdMap(server, chan);

        const nick = joiningUser.nick;
        const syncType: MembershipSyncKind = kind === "names" ? "initial" : "incremental";
        if (!server.shouldSyncMembershipToMatrix(syncType, chan)) {
            req.log.info("IRC onJoin(%s) %s to %s - not syncing.", kind, nick, chan);
            return BridgeRequestErr.ERR_NOT_MAPPED;
        }

        req.log.info("onJoin(%s) %s to %s", kind, nick, chan);
        // if the person joining is a virtual IRC user, do nothing.
        if (joiningUser.isVirtual) {
            return BridgeRequestErr.ERR_VIRTUAL_USER;
        }

        this.quitDebouncer.onJoin(nick, server);

        // get virtual matrix user
        const matrixUser = await this.ircBridge.getMatrixUser(joiningUser);
        const matrixRooms = await this.ircBridge.getStore().getMatrixRoomsForChannel(server, chan);
        const intent = this.ircBridge.getAppServiceBridge().getIntent(
            matrixUser.getId()
        );
        const promises = matrixRooms.map(async (room) => {
            /** If this is a "NAMES" query, we can make use of the joinedMembers call we made
             * to check if the user already exists in the room. This should save oodles of time.
             */
            if (kind === "names" &&
                this.ircBridge.getMemberListSyncer(server).isRemoteJoinedToRoom(
                    room.getId(),
                    matrixUser.getId()
                )) {
                req.log.debug("Not joining to %s, already joined.", room.getId());
                return;
            }
            req.log.info("Joining room %s and setting presence to online", room.getId());
            await this.membershipQueue.join(room.getId(), matrixUser.getId(), req);
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
                return; // unexpected given isVirtual == true, but meh, bail.
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
            const matrixUser = await this.ircBridge.getMatrixUser(kickee);
            req.log.info("Mapped kickee nick %s to %s", kickee.nick, JSON.stringify(matrixUser));
            const matrixRooms = await this.ircBridge.getStore().getMatrixRoomsForChannel(server, chan);
            if (matrixRooms.length === 0) {
                req.log.info("No mapped matrix rooms for IRC channel %s", chan);
                return;
            }
            await Promise.all(matrixRooms.map(async (room) => {
                await this.membershipQueue.leave(
                    room.getId(), matrixUser.getId(), req,
                );
                try {
                    await this.roomAccessSyncer.removePowerLevels(room.getId(), [matrixUser.getId()]);
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
     * @param {IrcServer} server : The sending IRC server.
     * @param {IrcUser} leavingUser : The user who parted.
     * @param {string} chan : The channel that was left.
     * @param {string} kind : The kind of part (e.g. PART, KICK, BAN, QUIT, netsplit, etc)
     * @return {Promise} which is resolved/rejected when the request finishes.
     */
    public async onPart (req: BridgeRequest, server: IrcServer, leavingUser: IrcUser,
                         chan: string, kind: string): Promise<BridgeRequestErr|undefined> {
        this.incrementMetric("part");
        this.invalidateNickUserIdMap(server, chan);
        // parts are always incremental (only NAMES are initial)
        if (!server.shouldSyncMembershipToMatrix("incremental", chan)) {
            req.log.info("Server doesn't mirror parts.");
            return undefined;
        }
        const nick = leavingUser.nick;
        req.log.info("onPart(%s) %s to %s", kind, nick, chan);


        const matrixRooms = await this.ircBridge.getStore().getMatrixRoomsForChannel(server, chan);
        if (matrixRooms.length === 0) {
            req.log.info("No mapped matrix rooms for IRC channel %s", chan);
            return BridgeRequestErr.ERR_NOT_MAPPED;
        }

        // if the person leaving is a virtual IRC user, do nothing. Unless it's a part.
        if (leavingUser.isVirtual && kind !== "part") {
            return BridgeRequestErr.ERR_VIRTUAL_USER;
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
            // Presence syncing and Quit Debouncing
            //  When an IRC user quits, debounce before leaving them from matrix rooms. In the meantime,
            //  update presence to "offline". If the user rejoins a channel before timeout, do not part
            //  user from the room. Otherwise timeout and leave rooms.
            if (kind === "quit" && server.shouldDebounceQuits()) {
                const shouldBridgePart = await this.quitDebouncer.debounceQuit(
                    req, server, matrixUser, nick
                );
                if (!shouldBridgePart) {
                    return undefined;
                }
            }
            userId = matrixUser.userId;
        }

        // get virtual matrix user
        req.log.info("Mapped nick %s to %s", nick, userId);
        const promise = await Promise.all(matrixRooms.map(async (room) => {
            await this.membershipQueue.leave(
                room.getId(), userId, req, true, "Client PARTed from channel",
                leavingUser.isVirtual ? this.ircBridge.appServiceUserId : undefined);
            try {
                await this.roomAccessSyncer.removePowerLevels(room.getId(), [userId]);
            }
            catch (ex) {
                // This is non-critical but annoying.
                req.log.warn("Failed to remove power levels for leaving user.");
            }
        }));
        await promise;
        return undefined;
    }

    /**
     * Called when a user sets a mode in a channel.
     * @param {Request} req The metadata request
     * @param {IrcServer} server : The sending IRC server.
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
     * @param {IrcServer} server : The sending IRC server.
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
    public async onMetadata(req: BridgeRequest, client: BridgedClient, msg: string, force: boolean, ircMsg?: IrcMessage) {
        req.log.info("%s : Sending metadata '%s'", client, msg);
        if (!this.ircBridge.isStartedUp && !force) {
            req.log.info("Suppressing metadata: not started up.");
            return BridgeRequestErr.ERR_DROPPED;
        }

        const botUser = new MatrixUser(this.ircBridge.appServiceUserId);

        if (!client.userId) {
            // Probably the bot
            return undefined;
        }

        console.log("IRCMSG:", ircMsg);

        if (ircMsg && ircMsg.command === "err_nosuchnick") {
            const otherNick = ircMsg.args[1];
            const otherUser = new MatrixUser(client.server.getUserIdFromNick(otherNick));
            const room = await this.ircBridge.getStore().getMatrixPmRoom(client.userId, otherUser.userId);
            if (room) {
                return this.ircBridge.sendMatrixAction(
                    room, otherUser, new MatrixAction(
                        "notice", `User is not online or does not exist.`
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

    private invalidateNickUserIdMap(server: IrcServer, channel: string) {
        this.nickUserIdMapCache.delete(`${server.domain}:${channel}`);
    }
}

