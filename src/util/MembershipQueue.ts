import { Bridge } from "matrix-appservice-bridge";
import { BridgeRequest } from "../models/BridgeRequest";
import getLogger from "../logging";
import { QueuePool } from "./QueuePool";
const log = getLogger("MembershipQueue");

const CONCURRENT_ROOM_LIMIT = 8;
const ATTEMPTS_LIMIT = 10;
const JOIN_DELAY_MS = 500;
const JOIN_DELAY_CAP_MS = 30 * 60 * 1000; // 30 mins

interface QueueUserItem {
    type: "join"|"leave";
    kickUser?: string;
    reason?: string;
    attempts: number;
    roomId: string;
    userId: string;
    retry: boolean;
    req: BridgeRequest;
}

/**
 * This class processes membership changes for rooms in a linearized queue.
 */
export class MembershipQueue {
    private queuePool: QueuePool<QueueUserItem>;

    constructor(private bridge: Bridge, private botUserId: string) {
        this.queuePool = new QueuePool(CONCURRENT_ROOM_LIMIT, this.serviceQueue.bind(this));
    }

    /**
     * Join a user to a room
     * @param roomId The roomId to join
     * @param userId Leave empty to act as the bot user.
     * @param req The request entry for logging context
     * @param retry Should the request retry if it fails
     */
    public async join(roomId: string, userId: string|undefined, req: BridgeRequest, retry = true) {
        return this.queueMembership({
            roomId,
            userId: userId || this.botUserId,
            retry,
            req,
            attempts: 0,
            type: "join",
        });
    }

    /**
     * Leave OR kick a user from a room
     * @param roomId The roomId to leave
     * @param userId Leave empty to act as the bot user.
     * @param req The request entry for logging context
     * @param retry Should the request retry if it fails
     * @param reason Reason for leaving/kicking
     * @param kickUser The user to be kicked. If left blank, this will be a leave.
     */
    public async leave(roomId: string, userId: string, req: BridgeRequest,
                       retry = true, reason?: string, kickUser?: string) {
        return this.queueMembership({
            roomId,
            userId: userId || this.botUserId,
            retry,
            req,
            attempts: 0,
            reason,
            kickUser,
            type: "leave",
        })
    }

    public async queueMembership(item: QueueUserItem) {
        try {
            return await this.queuePool.enqueue("", item, this.hashRoomId(item.roomId));
        }
        catch (ex) {
            log.error(`Failed to handle membership: ${ex}`);
            throw ex;
        }
    }

    private hashRoomId(roomId: string) {
        return Array.from(roomId).map((s) => s.charCodeAt(0)).reduce((a, b) => a + b, 0) % CONCURRENT_ROOM_LIMIT;
    }

    private async serviceQueue(item: QueueUserItem) {
        const { req, roomId, userId, reason, kickUser, attempts, type } = item;
        log.debug(`${userId}@${roomId} -> ${type} (reason: ${reason || "none"}, kicker: ${kickUser})`);
        const intent = this.bridge.getIntent(kickUser || userId);
        try {
            if (type === "join") {
                await intent.join(roomId);
            }

            if (kickUser) {
                await intent.kick(roomId, kickUser, reason);
            }
            else if (reason) {
                // Self kick to add a reason
                await intent.kick(roomId, userId, reason);
            }
            await intent.leave(roomId);
        }
        catch (ex) {
            if (!this.shouldRetry(ex, attempts)) {
                throw ex;
            }
            const delay = Math.min(
                (JOIN_DELAY_MS * attempts) + (Math.random() * 500),
                JOIN_DELAY_CAP_MS
            );
            req.log.warn(`Failed to join ${roomId}, delaying for ${delay}ms`);
            req.log.debug(`Failed with: ${ex.errcode} ${ex.message}`);
            await new Promise((r) => setTimeout(r, delay));
            this.queueMembership({...item, attempts: item.attempts + 1});
        }
    }

    private shouldRetry(ex: {code: string; errcode: string; httpStatus: number}, attempts: number): boolean {
        return !(
            attempts === ATTEMPTS_LIMIT ||
            ex.errcode === "M_FORBIDDEN" ||
            ex.httpStatus === 403
        );
    }
}
