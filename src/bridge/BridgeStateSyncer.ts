import { DataStore } from "../datastore/DataStore";
import { QueuePool } from "../util/QueuePool";
import { Bridge } from "matrix-appservice-bridge";

const SYNC_INTERVAL = 1500;
const SYNC_CONCURRENCY = 3;
const TYPE = "uk.half-shot.bridge";

interface QueueItem {
    roomId: string;
    mappings: Array<{networkId: string; channel: string}>
}

/**
 * This class will set bridge room state according to [MSC2346](https://github.com/matrix-org/matrix-doc/pull/2346)
 */
export class BridgeStateSyncer {
    private syncQueue: QueuePool<QueueItem>;
    constructor(private datastore: DataStore, private bridge: Bridge) {
        this.syncQueue = new QueuePool(SYNC_CONCURRENCY, this.syncRoom.bind(this));
    }

    public async beginSync() {
        const mappings = this.datastore.getAllChannelMappings();
    }

    public async syncRoom(item: QueueItem) {
        const intent = this.bridge.getIntent();
        for (const mapping of item.mappings) {
            const key = BridgeStateSyncer.createStateKey(mapping.networkId, mapping.channel);
            const eventData = await intent.getStateEvent(item.roomId, TYPE, key);
        }
    }

    public static createStateKey(networkId: string, channel: string) {
        networkId = networkId.replace(/\//g, "%2F");
        channel = channel.replace(/\//g, "%2F");
        return `org.matrix.appservice-irc://irc/${networkId}/${channel}`
    }
}
