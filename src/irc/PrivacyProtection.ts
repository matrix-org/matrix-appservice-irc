import { MatrixRoom } from "matrix-appservice-bridge";
import QuickLRU from "quick-lru";
import { IrcBridge } from "../bridge/IrcBridge";
import { BridgeRequest } from "../models/BridgeRequest";
import { IrcRoom } from "../models/IrcRoom";
import { IrcServer } from "./IrcServer";


const MAX_CACHE_SIZE = 64;
/**
 * This class manages the visiblity of IRC messages on Matrix. It will check upon each IRC message
 * that all Matrix users are connected to the channel to avoid messages leaking to the Matrix side.
 *
 */
export class PrivacyProtection {
    private roomBlockedSet = new Set<string>();
    private memberListCache = new QuickLRU<string, string[]>({ maxSize: MAX_CACHE_SIZE });
    constructor(private ircBridge: IrcBridge) {

    }

    public get blockedRoomCount(): number {
        return this.roomBlockedSet.size;
    }

    /**
     * Clear the membership cache for a room.
     * @param roomId The Matrix room ID.
     */
    public clearRoomFromCache(roomId: string): void {
        this.memberListCache.delete(roomId);
    }

    /**
     * Get a cached copy of all Matrix (not IRC) users in a room.
     * @param roomId The Matrix room to inspect.
     * @returns An array of Matrix userIDs.
     */
    private async getMatrixUsersForRoom(roomId: string): Promise<string[]> {
        let members = this.memberListCache.get(roomId);
        if (members) {
            return members;
        }
        const bot = this.ircBridge.getAppServiceBridge().getBot();
        members =
            Object.keys(await bot.getJoinedMembers(roomId)).filter(m => !bot.isRemoteUser(m));
        this.memberListCache.set(roomId, members);
        return members;
    }


    /**
     * If configured, check to see if the all Matrix users in a given room are
     * joined to a channel. If they are not, drop the message.
     * @param req The IRC request
     * @param server The IRC server.
     */
    private async shouldRequireMatrixUserJoined(server: IrcServer, channel: string, roomId: string): Promise<boolean> {
        // The room state takes priority.
        const notRequired =
            await this.ircBridge.roomConfigs.allowUnconnectedMatrixUsers(roomId, new IrcRoom(server, channel));
        if (notRequired !== null) {
            return !notRequired;
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
        const members = await this.getMatrixUsersForRoom(roomId);
        const pool = this.ircBridge.getClientPool();
        let isMissingUsers = false;
        for (const userId of members) {
            if (userId === this.ircBridge.appServiceUserId) {
                continue;
            }
            const banReason = this.ircBridge.matrixBanSyncer?.isUserBanned(userId);
            if (banReason) {
                req.log.debug(`Not syncing ${userId} - user banned (${banReason})`)
                continue;
            }
            const client = pool.getBridgedClientByUserId(server, userId);
            if (!client) {
                req.log.warn(`${userId} has not connected to IRC yet, not bridging message`);
                isMissingUsers = true;
                continue;
            }
            if (!client.inChannel(channel)) {
                req.log.warn(`${userId} has not joined the channel yet, not bridging message`);
                isMissingUsers = true;
            }
        }
        if (!isMissingUsers) {
            return true;
        }
        // For the missing users, attempt to join them to the channel. Any that fail to join should be kicked.
        this.ircBridge.syncMembersInRoomToIrc(req, roomId, new IrcRoom(server, channel), true);
        return false;
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
        const key = roomId + ircRoom.getId();
        if (this.roomBlockedSet.has(key) === blocked) {
            return;
        }
        if (blocked) {
            this.roomBlockedSet.add(key);
            req.log.warn(`${roomId} ${ircRoom.getId()} is now blocking IRC messages`);
        }
        else {
            this.roomBlockedSet.delete(key);
            req.log.warn(`${roomId} ${ircRoom.getId()} has now unblocked IRC messages`);
        }
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
     * Get rooms which are safe to bridge IRC messages to.
     * @param req The bridge request
     * @param server The IRC server
     * @param channel The IRC channel
     * @returns An array of Matrix rooms
     */
    async getSafeRooms(req: BridgeRequest, server: IrcServer, channel: string): Promise<MatrixRoom[]> {
        const allRooms = await this.ircBridge.getStore().getMatrixRoomsForChannel(server, channel);
        return (await Promise.all((allRooms).map(async (room) => {
            const required = await this.shouldRequireMatrixUserJoined(server, channel, room.roomId);
            req.log.debug(`${room.roomId} ${required ? "requires" : "does not require"} Matrix users to be joined`);
            if (!required) {
                return room;
            }
            const allowed = await this.areAllMatrixUsersJoined(req, server, channel, room.roomId);
            // Do so asynchronously, as we don't want to block message handling on this.
            this.setBlockedStateInRoom(req, room.roomId, new IrcRoom(server, channel), !allowed).catch(req.log.error);
            return allowed ? room : undefined;
        }))).filter(r => r !== undefined) as MatrixRoom[];
    }
}
