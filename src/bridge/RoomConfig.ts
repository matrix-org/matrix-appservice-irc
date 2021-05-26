import { Bridge } from "matrix-appservice-bridge";
import { IrcRoom } from "../models/IrcRoom";
import QuickLRU from "quick-lru";
import getLogger from "../logging";

interface RoomConfigContent {
    lineLimit?: number;
    allowUnconnectedMatrixUsers: boolean|null;
}

export interface RoomConfigConfig {
    enabled: boolean;
    lineLimitMax?: number;
    allowUnconnectedMatrixUsers?: boolean;
}

const MAX_CACHE_SIZE = 512;
const STATE_TIMEOUT_MS = 2000;

const log = getLogger("RoomConfig");
export class RoomConfig {
    public static readonly STATE_EVENT_TYPE = 'org.matrix.appservice-irc.config';
    private cache = new QuickLRU<string, RoomConfigContent|undefined>({maxSize: MAX_CACHE_SIZE});
    constructor(private bridge: Bridge, public config?: RoomConfigConfig) { }

    /**
     * Fetch the state for the room, preferring a keyed state event over a global one.
     * This request will time out after `STATE_TIMEOUT_MS` if the state could not be fetched in time.
     * @param roomId The Matrix room ID
     * @param ircRoom The IRC room we want the configuration for.
     * @returns A content object containing the configuration, or null if the event was not found or the
     *          request timed out.
     */
    private async getRoomState(roomId: string, ircRoom?: IrcRoom): Promise<RoomConfigContent|null> {
        if (!this.config?.enabled) {
            // If not enabled, always return null
            return null;
        }
        const cacheKey = `${roomId}:${ircRoom?.getId() || 'global'}`;
        let keyedConfig = this.cache.get(cacheKey);
        if (keyedConfig) {
            return keyedConfig;
        }
        const internalFunc = async () => {
            const intent = this.bridge.getIntent();
            keyedConfig = ircRoom &&
                await intent.getStateEvent(roomId, RoomConfig.STATE_EVENT_TYPE, ircRoom.getId(), true);
            if (!keyedConfig) {
                // Fall back to an empty key
                keyedConfig = await intent.getStateEvent(roomId, RoomConfig.STATE_EVENT_TYPE, '', true);
            }
            log.debug(
                `Stored new config for ${cacheKey}: ${keyedConfig ? 'No config set' : JSON.stringify(keyedConfig)}`
            );
            this.cache.set(cacheKey, keyedConfig || undefined);
            return keyedConfig as RoomConfigContent|null;
        }
        // We don't want to spend too long trying to fetch the state, so return null.
        return Promise.race([
            internalFunc(),
            new Promise<null>(res => setTimeout(res, STATE_TIMEOUT_MS)),
        // We *never* want this function to throw, as it's critical for the bridging of messages.
        // Instead we return null for any errors.
        ]).catch(ex => {
            log.warn(`Failed to fetch state for ${cacheKey}`, ex);
            return null;
        })
    }

    /**
     * Invalidate the cache for a room.
     * @param roomId The Matrix roomId
     * @param stateKey The state event's key
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
        if (typeof roomState?.lineLimit !== 'number' || roomState.lineLimit <= 0) {
            // A missing line limit or an invalid one is considered invalid.
            return null;
        }
        return Math.min(roomState.lineLimit, this.config?.lineLimitMax ?? roomState.lineLimit);
    }
}
