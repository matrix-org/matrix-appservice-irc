/**
 * Synchronises Matrix `m.policy.rule` events with the bridge to filter specific
 * users from using the service.
 */

import { Intent, MatrixUser, WeakStateEvent } from "matrix-appservice-bridge";
import { MatrixGlob } from "matrix-bot-sdk";

export interface MatrixBanSyncConfig {
    rooms: string[];
}

enum BanEntityType {
    Server = "m.policy.rule.server",
    Room = "m.policy.rule.room",
    User = "m.policy.rule.user"
}

interface BanEntity {
    matcher: MatrixGlob;
    entityType: BanEntityType;
    reason: string;
}

interface MPolicyContent {
    entity: string;
    reason: string;
    reccomendation: "m.ban";
}

function eventTypeToBanEntityType(eventType: string): BanEntityType|null {
    switch (eventType) {
        case "m.policy.rule.user":
            return BanEntityType.User;
        case "m.policy.rule.room":
            return BanEntityType.Room;
        case "m.policy.rule.server":
            return BanEntityType.Server
        default:
            return null;
    }
}

export class MatrixBanSync {
    private bannedEntites = new Map<string, BanEntity>();
    constructor(private config: MatrixBanSyncConfig) { }

    public async syncRules(intent: Intent) {
        this.bannedEntites.clear();
        for (const roomId of this.config.rooms) {
            await intent.join(await intent.resolveRoom(roomId));
            const roomState = await intent.roomState(roomId, false) as WeakStateEvent[];
            for (const evt of roomState) {
                this.handleIncomingState(evt);
            }
        }
    }

    /**
     * Is the given room considered part of the bridge's ban list set.
     * @param roomId A Matrix room ID.
     * @returns true if state should be handled from the room, false otherwise.
     */
    public isInterestedInRoom(roomId: string): boolean {
        return this.config.rooms.includes(roomId);
    }

    public handleIncomingState(evt: WeakStateEvent) {
        const content = evt.content as unknown as MPolicyContent;
        const entityType = eventTypeToBanEntityType(evt.type);
        if (!entityType) {
            return false;
        }
        const key = `${evt.room_id}:${evt.state_key}`;
        if (evt.content.entity === undefined) {
            // Empty, delete instead.
            this.bannedEntites.delete(key);
            return false;
        }
        if (content.reccomendation !== "m.ban") {
            // We only deal with m.ban at the moment.
            return false;
        }
        this.bannedEntites.set(key, {
            matcher: new MatrixGlob(content.entity),
            entityType,
            reason: content.reason || "No reason given",
        });
        return true;
    }

    /**
     * Check if a user is banned by via a ban list.
     * @param user A userId string or a MatrixUser object.
     * @returns Either a string reason for the ban, or false if the user was not banned.
     */
    public isUserBanned(user: MatrixUser|string): string|false {
        const matrixUser = typeof user === "string" ? new MatrixUser(user) : user;
        for (const entry of this.bannedEntites.values()) {
            if (entry.entityType === BanEntityType.Server && entry.matcher.test(matrixUser.host)) {
                return entry.reason;
            }
            if (entry.entityType === BanEntityType.User && entry.matcher.test(matrixUser.userId)) {
                return entry.reason;
            }
        }
        return false;
    }

    public async updateConfig(config: MatrixBanSyncConfig, intent: Intent) {
        this.config = config;
        await this.syncRules(intent);
    }
}
