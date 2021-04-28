import { Bridge } from "matrix-appservice-bridge";
import { IrcRoom } from "../models/IrcRoom";
import QuickLRU from "quick-lru";
import getLogger from "../logging";

interface RoomConfigContent {
    lineLimit?: number;
}

const MAX_CACHE_SIZE = 512;

const log = getLogger("RoomConfig");
export class RoomConfig {
    public static readonly STATE_EVENT_TYPE = 'org.matrix.appservice-irc.room-config';
    private cache = new QuickLRU<string, RoomConfigContent|undefined>({maxSize: MAX_CACHE_SIZE});
    constructor(private bridge: Bridge) { }

    private async getRoomState(roomId: string, ircRoom?: IrcRoom): Promise<RoomConfigContent|null> {
        const cacheKey = `${roomId}:${ircRoom?.getId() || 'global'}`;
        let keyedConfig = this.cache.get(cacheKey);
        if (keyedConfig) {
            return keyedConfig;
        }
        const intent = this.bridge.getIntent();
        keyedConfig = ircRoom && await intent.getStateEvent(roomId, RoomConfig.STATE_EVENT_TYPE, ircRoom.getId(), true);
        if (!keyedConfig) {
            // Fall back to an empty key
            keyedConfig = await intent.getStateEvent(roomId, RoomConfig.STATE_EVENT_TYPE, '', true);
        }
        log.debug(`Stored new config for ${cacheKey}:`, keyedConfig || 'No config set');
        this.cache.set(cacheKey, keyedConfig || undefined);
        return keyedConfig as RoomConfigContent|null;
    }

    /**
     * Invalidate the cache for a room. Provide the key
     * @param roomId The Matrix roomId
     * @param stateKey The state event's key.
     */
    public invalidateConfig(roomId: string, stateKey = 'global') {
        log.info(`Invalidating config for ${roomId}:${stateKey}`);
        this.cache.delete(`${roomId}:${stateKey}`)
    }

    /**
     * Get the per-room configuration for the paste bin limit for a room.
     * @param roomId The Matrix roomId
     * @param ircRoom The IRC roomId. Optional.
     * @returns The number of lines required for a pastebin. `null` means no limit set in the room.
     */
    public async getLineLimit(roomId: string, ircRoom?: IrcRoom) {
        const roomState = await this.getRoomState(roomId, ircRoom);
        if (typeof roomState?.lineLimit !== 'number' || roomState.lineLimit > 0) {
            // A missing line limit or an invalid one is considered invalid.
            return null;
        }
        return roomState.lineLimit;
    }
}