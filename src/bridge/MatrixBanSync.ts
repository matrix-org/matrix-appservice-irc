/**
 * Synchronises Matrix `m.policy.rule` events with the bridge to filter specific
 * users from using the service.
 */

import { Intent, MatrixUser, WeakStateEvent } from "matrix-appservice-bridge";
import { MatrixGlob } from "matrix-bot-sdk";
import { getLogger } from "../logging";

const log = getLogger("MatrixBanSync");
export interface MatrixBanSyncConfig {
    rooms: string[];
}

enum BanEntityType {
    Server = "m.policy.rule.server",
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
        case "m.policy.rule.server":
            return BanEntityType.Server
        default:
            return null;
    }
}

export class MatrixBanSync {
    private bannedEntites = new Map<string, BanEntity>();
    private interestingRooms = new Set<string>();
    constructor(private config: MatrixBanSyncConfig) { }

    public async syncRules(intent: Intent) {
        this.bannedEntites.clear();
        this.interestingRooms.clear();
        for (const roomIdOrAlias of this.config.rooms) {
            try {
                const roomId = await intent.join(roomIdOrAlias);
                this.interestingRooms.add(roomId);
                const roomState = await intent.roomState(roomId, false) as WeakStateEvent[];
                for (const evt of roomState) {
                    this.handleIncomingState(evt, roomId);
                }
            }
            catch (ex) {
                log.error(`Failed to read ban list from ${roomIdOrAlias}`, ex);
            }
        }
    }

    /**
     * Is the given room considered part of the bridge's ban list set.
     * @param roomId A Matrix room ID.
     * @returns true if state should be handled from the room, false otherwise.
     */
    public isInterestedInRoom(roomId: string): boolean {
        return this.interestingRooms.has(roomId);
    }

    /**
     * Checks to see if the incoming state is a reccomendation entry.
     * @param evt A Matrix state event. Unknown state events will be filtered out.
     * @returns True if the event was a new ban, and existing clients should be checked. False otherwise.
     */
    public handleIncomingState(evt: WeakStateEvent, roomId: string) {
        const content = evt.content as unknown as MPolicyContent;
        const entityType = eventTypeToBanEntityType(evt.type);
        if (!entityType) {
            return false;
        }
        const key = `${roomId}:${evt.state_key}`;
        if (evt.content.entity === undefined) {
            // Empty, delete instead.
            log.info(`Deleted ban rule ${evt.type} matching ${content.entity}`);
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
        log.info(`New ban rule ${evt.type} matching ${content.entity}`);
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

    /**
     * Should be called when the bridge config has been updated.
     * @param config The new config.
     * @param intent The bot user intent.
     */
    public async updateConfig(config: MatrixBanSyncConfig, intent: Intent) {
        this.config = config;
        await this.syncRules(intent);
    }
}
