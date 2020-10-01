// Controls the logic for determining which membership lists should be synced and
// handles the sequence of events until the lists are in sync.

import Bluebird from "bluebird";
import { IrcBridge } from "./IrcBridge";
import { AppServiceBot } from "matrix-appservice-bridge";
import { IrcServer } from "../irc/IrcServer";
import { QueuePool } from "../util/QueuePool";
import logging from "../logging";
import { IrcRoom } from "../models/IrcRoom";
import { BridgeRequest } from "../models/BridgeRequest";
import * as promiseutil from "../promiseutil";
import { Queue } from "../util/Queue";

const log = logging("MemberListSyncer");

interface MemberStateEvent {
    type: string;
    content: {
        membership: string;
    };
    state_key: string;
}

interface RoomInfo {
    id: string;
    state?: string;
    displayNames: {[userId: string]: string};
    realJoinedUsers: string[];
    remoteJoinedUsers: string[];
}

interface LeaveQueueItem {
    roomId: string;
    userIds: string[];
}

type InjectJoinFn = (roomId: string, joiningUserId: string,
                     displayName: string, isFrontier: boolean) => PromiseLike<unknown>;

export class MemberListSyncer {
    private syncableRoomsPromise: Promise<RoomInfo[]>|null = null;
    private usersToLeave = 0;
    private usersToJoin = 0;
    private memberLists: {
        irc: {[channel: string]: string[]};
        matrix: {[roomId: string]: RoomInfo};
    } = {
        irc: {},
        matrix: {},
    }
    private leaveQueuePool: QueuePool<LeaveQueueItem>;
    constructor(private ircBridge: IrcBridge, private appServiceBot: AppServiceBot, private server: IrcServer,
                private appServiceUserId: string, private injectJoinFn: InjectJoinFn) {
        // A queue which controls the rate at which leaves are sent to Matrix. We need this queue
        // because Synapse is slow. Synapse locks based on the room ID, so there is no benefit to
        // having 2 in-flight requests for the same room ID. As a result, we want to queue based
        // on the room ID, and let N "room queues" be processed concurrently. This can be
        // represented as a QueuePool of size N, which enqueues all the requests for a single
        // room in one go, which we can do because IRC sends all the nicks down as NAMES. For each
        // block of users in a room queue, we need another Queue to ensure that there is only ever
        // 1 in-flight leave request at a time per room queue.
        this.leaveQueuePool = new QueuePool(3, this.leaveUsersInRoom.bind(this));
    }

    public isRemoteJoinedToRoom(roomId: string, userId: string) {
        const room = this.memberLists.matrix[roomId];
        if (room) {
            return room.remoteJoinedUsers.includes(userId);
        }
        return false;
    }

    public async sync() {
        const server = this.server;
        if (!server.isMembershipListsEnabled()) {
            log.info("%s does not have membership list syncing enabled.", server.domain);
            return;
        }
        log.info("Checking membership lists for syncing on %s", server.domain);
        let start = Date.now();
        const rooms = await this.getSyncableRooms();
        log.info("Found %s syncable rooms (%sms)", rooms.length, Date.now() - start);
        this.leaveIrcUsersFromRooms(rooms);
        start = Date.now();
        log.info("Joining Matrix users to IRC channels...");
        await this.joinMatrixUsersToChannels(rooms, this.injectJoinFn);
        log.info("Joined Matrix users to IRC channels. (%sms)", Date.now() - start);
        // NB: We do not need to explicitly join IRC users to Matrix rooms
        // because we get all of the NAMEs/JOINs as events when we connect to
        // the IRC server. This effectively "injects" the list for us.
    }

    public async getChannelsToJoin() {
        const server = this.server;
        log.debug("getChannelsToJoin => %s", server.domain);
        const rooms = await this.getSyncableRooms();

        // map room IDs to channels on this server.
        const channels = new Set<string>();
        const roomInfoMap: {[roomId: string]: RoomInfo} = {};
        const roomIds = rooms.map((roomInfo) => {
            roomInfoMap[roomInfo.id] = roomInfo;
            return roomInfo.id;
        });
        await this.ircBridge.getStore().getIrcChannelsForRoomIds(roomIds).then((roomIdToIrcRoom) => {
            Object.keys(roomIdToIrcRoom).forEach((roomId) => {
                // only interested in rooms for this server
                const ircRooms = roomIdToIrcRoom[roomId].filter((ircRoom) => {
                    return ircRoom.server.domain === server.domain;
                });
                ircRooms.forEach((ircRoom) => {
                    channels.add(ircRoom.channel);
                    log.debug(
                        "%s should be joined because %s real Matrix users are in room %s",
                        ircRoom.channel, roomInfoMap[roomId].realJoinedUsers.length, roomId
                    );
                    if (roomInfoMap[roomId].realJoinedUsers.length < 5) {
                        log.debug("These are: %s", JSON.stringify(roomInfoMap[roomId].realJoinedUsers));
                    }
                });
            })
        });

        const channelsArray = Array.from(channels);
        log.debug(
            "getChannelsToJoin => %s should be synced: %s",
            channelsArray.length, JSON.stringify(channelsArray)
        );
        return channelsArray;
    }

    // map irc channel to a list of room IDs. If all of those
    // room IDs have no real users in them, then part the bridge bot too.
    public async checkBotPartRoom(ircRoom: IrcRoom, req: BridgeRequest) {
        if (!ircRoom.channel.startsWith("#")) {
            return; // don't leave PM rooms
        }
        const matrixRooms = await this.ircBridge.getStore().getMatrixRoomsForChannel(
            ircRoom.server, ircRoom.channel
        );

        if (matrixRooms.length === 0) {
            // no mapped rooms, leave the channel.
            await this.ircBridge.partBot(ircRoom);
            return;
        }

        // At least 1 mapped room - query for the membership list in each room. If there are
        // any real users still left in the room, then do not part the bot from the channel.
        // Query via /$room_id/state rather than /initialSync as the latter can cause
        // the bridge to spin for minutes if the response is large.

        let shouldPart = true;
        for (let i = 0; i < matrixRooms.length; i++) {
            const roomId = matrixRooms[i].getId();
            req.log.debug("checkBotPartRoom: Querying room state in room %s", roomId);
            const res = await this.appServiceBot.getClient().roomState(roomId);
            const data = MemberListSyncer.getRoomMemberData(ircRoom.server, roomId, res, this.appServiceUserId);
            req.log.debug(
                "checkBotPartRoom: %s Matrix users are in room %s", data.reals.length, roomId
            );
            if (data.reals.length > 0) {
                shouldPart = false;
                break;
            }
        }

        if (shouldPart) {
            await this.ircBridge.partBot(ircRoom);
        }
    }

    // grab all rooms the bot knows about which have at least 1 real user in them.
    // On startup, this can be called multiple times, so we cache the first request's promise
    // and return that instead of making double hits.
    public getSyncableRooms(resetCache = false): Promise<RoomInfo[]> {
        if (resetCache) {
            this.syncableRoomsPromise = null;
        }
        if (this.syncableRoomsPromise) {
            log.debug("Returning existing getSyncableRooms Promise");
            return this.syncableRoomsPromise;
        }

        const fetchRooms = async () => {
            const roomInfoList: RoomInfo[] = [];

            const roomIdToChannel = await this.ircBridge.getStore().getAllChannelMappings();
            const joinedRoomIds = Object.entries(roomIdToChannel).filter(([roomId, channelSet]) => {
                const isInNetwork = !!channelSet.find(({networkId}) => this.server.getNetworkId() === networkId);
                return isInNetwork ? this.server.shouldSyncMembershipToIrc("initial", roomId) : false;
            }).map(([roomId]) => roomId);

            // fetch joined members allowing 50 in-flight reqs at a time
            const pool = new QueuePool(50, async (_roomId) => {
                const roomId = _roomId as string;
                let userMap: Record<string, {display_name: string; avatar: string}>|undefined;
                while (!userMap) {
                    try {
                        userMap = await this.appServiceBot.getJoinedMembers(roomId);
                    }
                    catch (err) {
                        log.error(`Failed to getJoinedMembers in room ${roomId}: ${err}`);
                        await Bluebird.delay(3000); // wait a bit before retrying
                    }
                }
                const roomInfo: RoomInfo = {
                    id: roomId,
                    displayNames: {}, // user ID => Display Name
                    realJoinedUsers: [], // user IDs
                    remoteJoinedUsers: [], // user IDs
                };
                const userIds = Object.keys(userMap);
                for (let j = 0; j < userIds.length; j++) {
                    const userId = userIds[j];
                    if (this.appServiceUserId === userId) {
                        continue;
                    }
                    if (this.appServiceBot.isRemoteUser(userId)) {
                        roomInfo.remoteJoinedUsers.push(userId);
                    }
                    else {
                        roomInfo.realJoinedUsers.push(userId);
                    }

                    if (userMap[userId].display_name) {
                        roomInfo.displayNames[userId] = userMap[userId].display_name as string;
                    }
                }
                roomInfoList.push(roomInfo);
                log.info(
                    "%s has %s real Matrix users and %s remote users (%s/%s)",
                    roomId, roomInfo.realJoinedUsers.length, roomInfo.remoteJoinedUsers.length,
                    roomInfoList.length, joinedRoomIds.length
                );
            });
            // wait for all the requests to go through
            await Promise.all(joinedRoomIds.map((roomId) => {
                return pool.enqueue(roomId, roomId);
            }));

            return roomInfoList.filter(function(roomInfo) {
                // filter out rooms with no real matrix users in them.
                return roomInfo.realJoinedUsers.length > 0;
            });
        }

        this.syncableRoomsPromise = fetchRooms();
        return this.syncableRoomsPromise;
    }

    private joinMatrixUsersToChannels(rooms: RoomInfo[], injectJoinFn: InjectJoinFn) {
        const d = promiseutil.defer();

        // filter out rooms listed in the rules
        const filteredRooms: RoomInfo[] = [];
        rooms.forEach((roomInfo) => {
            if (!this.server.shouldSyncMembershipToIrc("initial", roomInfo.id)) {
                log.debug(
                    "Trimming room %s according to config rules (matrixToIrc=false)",
                    roomInfo.id
                );
                if (!roomInfo.realJoinedUsers[0]) {
                    return; // no joined users at all
                }
                // trim the list to a single user. We do this rather than filter the
                // room out entirely because otherwise there will be NO matrix users
                // on the IRC-side resulting in no traffic whatsoever.
                roomInfo.realJoinedUsers = [roomInfo.realJoinedUsers[0]];
                log.debug("Trimmed to " + roomInfo.realJoinedUsers);
            }
            filteredRooms.push(roomInfo);
        });

        log.debug("%s rooms passed the config rules", filteredRooms.length);

        // map the filtered rooms to a list of users to join
        // [Room:{reals:[uid,uid]}, ...] => [{uid,roomid}, ...]
        const entries: { roomId: string; displayName: string; userId: string; frontier: boolean}[] = [];
        filteredRooms.forEach((roomInfo) => {
            roomInfo.realJoinedUsers.forEach((uid, index) => {
                entries.push({
                    roomId: roomInfo.id,
                    displayName: roomInfo.displayNames[uid],
                    userId: uid,
                    // Mark the first real matrix user f.e room so we can inject
                    // them first to get back up and running more quickly when there
                    // is no bot.
                    frontier: (index === 0)
                });
            });
        });
        // sort frontier markers to the front of the array
        entries.sort((a, b) => {
            if (a.frontier && !b.frontier) {
                return -1; // a comes first
            }
            else if (b.frontier && !a.frontier) {
                return 1; // b comes first
            }
            return 0; // don't care
        });

        log.debug("Got %s matrix join events to inject.", entries.length);
        this.usersToJoin = entries.length;
        // take the first entry and inject a join event
        const joinNextUser = () => {
            this.usersToJoin--;
            const entry = entries.shift();
            if (!entry) {
                d.resolve();
                return;
            }
            if (entry.userId.startsWith("@-")) {
                joinNextUser();
                return;
            }
            log.debug(
                "Injecting join event for %s in %s (%s left) is_frontier=%s",
                entry.userId, entry.roomId, entries.length, entry.frontier
            );
            Bluebird.cast(injectJoinFn(entry.roomId, entry.userId, entry.displayName, entry.frontier)).timeout(
                this.server.getMemberListFloodDelayMs()
            ).then(() => {
                joinNextUser();
            }).catch(() => {
                // discard error, this will be due to timeouts which we don't want to log
                joinNextUser();
            })
        }

        joinNextUser();

        return d.promise;
    }

    public leaveIrcUsersFromRooms(rooms: RoomInfo[]) {
        log.info(
            `leaveIrcUsersFromRooms: storing member list info for ${rooms.length} ` +
            `rooms for server ${this.server.domain}`
        );

        // Store the matrix room info in memory for later retrieval when NAMES is received
        // and updateIrcMemberList is called. At that point, we have enough information to
        // leave users from the channel that the NAMES is for.
        rooms.forEach((roomInfo) => {
            this.memberLists.matrix[roomInfo.id] = roomInfo;
        });
    }

    // Critical section of the leave queue pool.
    // item looks like:
    // {
    //   roomId: "!foo:bar", userIds: [ "@alice:bar", "@bob:bar", ... ]
    // }
    private async leaveUsersInRoom(item: LeaveQueueItem) {
        // We need to queue these up in ANOTHER queue so as not to have
        // 2 in-flight requests at the same time. We return a promise which resolves
        // when this room is completely done.
        const q = new Queue<string>(async (userId) => {
            log.debug(`Leaving ${userId} from ${item.roomId}`);
            // Do this here, we might not manage to leave but we won't retry.
            this.usersToLeave--;
            await this.ircBridge.getAppServiceBridge().getIntent(userId).leave(item.roomId);
        });

        await Promise.all(item.userIds.map((userId) =>
            q.enqueue(userId, userId)
        ));

        // Make sure to deop any users
        await this.ircBridge.ircHandler.roomAccessSyncer.removePowerLevels(item.roomId, item.userIds);
    }

    // Update the MemberListSyncer with the IRC NAMES_RPL that has been received for channel.
    // This will leave any matrix users that do not have their associated IRC nick in the list
    // of names for this channel.
    public async updateIrcMemberList(channel: string, names: {[nick: string]: unknown}) {
        if (this.memberLists.irc[channel] !== undefined ||
                !this.server.shouldSyncMembershipToMatrix("initial", channel)) {
            return;
        }
        this.memberLists.irc[channel] = Object.keys(names);

        log.info(
            `updateIrcMemberList: Updating IRC member list for ${channel} with ` +
            `${this.memberLists.irc[channel].length} IRC nicks`
        );

        // Convert the IRC channels nicks to userIds
        const ircUserIds = this.memberLists.irc[channel].map(
            (nick) => this.server.getUserIdFromNick(nick)
        );

        // For all bridged rooms, leave users from matrix that are not in the channel
        const roomsForChannel = await this.ircBridge.getStore().getMatrixRoomsForChannel(
            this.server, channel
        );

        if (roomsForChannel.length === 0) {
            log.info(`updateIrcMemberList: No bridged rooms for channel ${channel}`);
            return;
        }

        // If a userId is in remoteJoinedUsers, but not ircUserIds, intend on leaving roomId
        const promises: Promise<unknown>[] = [];
        let totalLeavingUsers = 0;
        roomsForChannel.forEach((matrixRoom) => {
            const roomId = matrixRoom.getId();
            const roomInfo = this.memberLists.matrix[roomId];
            if (!roomInfo) {
                return;
            }
            if (!roomInfo.remoteJoinedUsers || roomInfo.remoteJoinedUsers.length === 0) {
                return;
            }

            const usersToLeave = roomInfo.remoteJoinedUsers.filter(
                (userId) => {
                    return !ircUserIds.includes(userId);
                }
            );
            if (usersToLeave.length < 1) {
                return;
            }
            totalLeavingUsers += usersToLeave.length;
            // ID is the complete mapping of roomID/channel which will be unique
            promises.push(this.leaveQueuePool.enqueue(roomId + " " + channel, {
                roomId: roomId,
                userIds: usersToLeave,
            }));
        });
        log.info(
            `updateIrcMemberList: Leaving ${totalLeavingUsers} users as they are not in ${channel}.`
        );
        this.usersToLeave += totalLeavingUsers;
        await Promise.all(promises);
    }

    public getUsersWaitingToJoin() {
        return this.usersToJoin;
    }

    public getUsersWaitingToLeave() {
        return this.usersToLeave;
    }

    public addToLeavePool(userIds: string[], roomId: string, channel: string) {
        this.usersToLeave += userIds.length;
        this.leaveQueuePool.enqueue(roomId + " " + channel, {
            roomId,
            userIds
        });
    }

    private static getRoomMemberData(server: IrcServer, roomId: string,
                                    stateEvents: MemberStateEvent[],
                                    appServiceUserId: string) {
        stateEvents = stateEvents || [];
        const data: { roomId: string; virtuals: string[]; reals: string[] } = {
            roomId: roomId,
            virtuals: [],
            reals: []
        };
        stateEvents.forEach((event) => {
            if (event.type !== "m.room.member" || event.content.membership !== "join") {
                return;
            }
            const userId = event.state_key;
            if (userId === appServiceUserId) {
                return;
            }
            if (server.claimsUserId(userId)) {
                data.virtuals.push(userId);
            }
            else if (userId.startsWith("@-")) {
                // Ignore guest user IDs -- TODO: Do this properly by passing them through
            }
            else {
                data.reals.push(userId);
            }
        });
        return data;
    }
}
