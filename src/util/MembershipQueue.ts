import { Bridge } from "matrix-appservice-bridge";
import { BridgeRequest } from "../models/BridgeRequest";
import getLogger from "../logging";
import { QueuePool } from "./QueuePool";
import QuickLRU from "quick-lru";

const log = getLogger("MembershipQueue");

/**
 * This class processes membership changes in a queue.
 */

const CONCURRENT_ROOM_LIMIT = 8;
const ATTEMPTS_LIMIT = 10;
const JOIN_DELAY_MS = 250;
const JOIN_DELAY_CAP_MS = 30 * 60 * 1000; // 30 mins
const ROOM_QUEUE_CACHE_SIZE = 500;

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

export class MembershipQueue {
    private roomIdIndexes: QuickLRU<string, number> = new QuickLRU({ maxSize: ROOM_QUEUE_CACHE_SIZE });
    private queuePool: QueuePool<QueueUserItem>;

    constructor(private bridge: Bridge) {
        this.queuePool = new QueuePool(CONCURRENT_ROOM_LIMIT, this.serviceQueue.bind(this));
    }

    public async join(roomId: string, userId: string, req: BridgeRequest, retry = true) {
        return this.queueMembership({
            roomId,
            userId,
            retry,
            req,
            attempts: 0,
            type: "join",
        });
    }

    public async leave(roomId: string, userId: string, req: BridgeRequest,
                       retry = true, reason?: string, kickUser?: string) {
        return this.queueMembership({
            roomId,
            userId,
            retry,
            req,
            attempts: 0,
            reason,
            kickUser,
            type: "leave",
        })
    }

    public async queueMembership(item: QueueUserItem) {
        const queueNumber = this.roomIdIndexes.get(item.roomId) || Math.ceil(Math.random() * CONCURRENT_ROOM_LIMIT -1);
        this.roomIdIndexes.set(item.roomId, queueNumber);
        log.debug(`${item.roomId} is assigned to ${queueNumber}`);
        try {
            return await this.queuePool.enqueue("", item, queueNumber);
        }
        catch (ex) {
            log.error(`Failed to handle membership: ${ex}`);
            throw ex;
        }
    }

    private async serviceQueue(item: QueueUserItem): Promise<void> {
        log.debug(`${item.userId}@${item.roomId} -> ${item.type}`);
        const { req, roomId, userId, reason, kickUser, attempts } = item;
        const intent = this.bridge.getIntent(kickUser || userId);
        try {
            if (item.type === "join") {
                await intent.join(roomId);
            }
            else {
                await intent[kickUser ? "kick" : "leave"](roomId, userId, reason);
            }
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
            this.queueMembership(item);
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
