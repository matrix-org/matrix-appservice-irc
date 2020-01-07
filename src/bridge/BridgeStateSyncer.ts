import { DataStore } from "../datastore/DataStore";
import { QueuePool } from "../util/QueuePool";
import { Bridge } from "matrix-appservice-bridge";
import logging from "../logging";
import { IrcBridge } from "./IrcBridge";

const log = logging("BridgeStateSyncer");

const SYNC_CONCURRENCY = 3;
const TYPE = "uk.half-shot.bridge";

interface QueueItem {
    roomId: string;
    mappings: Array<{networkId: string; channel: string}>;
}

/**
 * This class will set bridge room state according to [MSC2346](https://github.com/matrix-org/matrix-doc/pull/2346)
 */
export class BridgeStateSyncer {
    private syncQueue: QueuePool<QueueItem>;
    constructor(private datastore: DataStore, private bridge: Bridge, private ircBridge: IrcBridge) {
        this.syncQueue = new QueuePool(SYNC_CONCURRENCY, this.syncRoom.bind(this));
    }

    public async beginSync() {
        log.info("Beginning sync of bridge state events");
        const allMappings = await this.datastore.getAllChannelMappings();
        Object.entries(allMappings).forEach(([roomId, mappings]) => {
            this.syncQueue.enqueue(roomId, {roomId, mappings});
        });
    }

    private async syncRoom(item: QueueItem) {
        log.info(`Syncing ${item.roomId}`);
        const intent = this.bridge.getIntent();
        for (const mapping of item.mappings) {
            const key = BridgeStateSyncer.createStateKey(mapping.networkId, mapping.channel);
            try {
                const eventData = await this.getStateEvent(item.roomId, TYPE, key);
                if (eventData !== null) { // If found, validate.
                    const expectedContent = this.createBridgeInfoContent(
                        item.roomId, mapping.networkId, mapping.channel
                    );

                    const isValid = expectedContent.channel.id === eventData.channel.id &&
                        expectedContent.network.id === eventData.network.id &&
                        expectedContent.network.displayname === eventData.network.displayname &&
                        expectedContent.protocol.id === eventData.protocol.id &&
                        expectedContent.protocol.displayname === eventData.protocol.displayname;

                    if (isValid) {
                        log.debug(`${key} is valid`);
                        continue;
                    }
                    log.info(`${key} is invalid`);
                }
            }
            catch (ex) {
                log.warn(`Encountered error when trying to sync ${item.roomId}`);
                break; // To be on the safe side, do not retry this room.
            }

            // Event wasn't found or was invalid, let's try setting one.
            const eventContent = this.createBridgeInfoContent(item.roomId, mapping.networkId, mapping.channel);
            const owner = await this.determineProvisionedOwner(item.roomId, mapping.networkId, mapping.channel);
            eventContent.creator = owner || intent.client.credentials.userId;
            try {
                await intent.sendStateEvent(item.roomId, TYPE, key, eventContent);
            }
            catch (ex) {
                log.error(`Failed to update room with new state content: ${ex.message}`);
            }
        }
    }

    private async determineProvisionedOwner(roomId: string, networkId: string, channel: string): Promise<string|null> {
        const room = await this.datastore.getRoom(roomId, networkId, channel);
        if (!room || room.data.origin !== "provision") {
            return null;
        }
        // Find out who dun it
        try {
            const ev = await this.getStateEvent(roomId, "m.room.bridging", `irc://${networkId}/${channel}`);
            if (ev?.status === "success") {
                return ev.user_id;
            }
            // Event not found or invalid, leave blank.
        }
        catch (ex) {
            log.warn(`Failed to get m.room.bridging information for room: ${ex.message}`);
        }
        return null;
    }

    private static createStateKey(networkId: string, channel: string) {
        networkId = networkId.replace(/\//g, "%2F");
        channel = channel.replace(/\//g, "%2F");
        return `org.matrix.appservice-irc://irc/${networkId}/${channel}`
    }

    private createBridgeInfoContent(roomId: string, networkId: string, channel: string) {
        const server = this.ircBridge.getServer(networkId);
        const serverName = server?.getReadableName() || undefined;
        return {
            creator: "", // Is this known?
            protocol: {
                id: "irc",
                displayname: "IRC",
            },
            network: {
                id: networkId,
                displayname: serverName,
            },
            channel: {
                id: channel,
                external_url: `irc://${networkId}/${channel}`
            }
        }
    }

    private async getStateEvent(roomId: string, eventType: string, key: string) {
        const intent = this.bridge.getIntent();
        try {
            return await intent.getStateEvent(roomId, eventType, key);
        }
        catch (ex) {
            if (ex.errcode !== "M_NOT_FOUND") {
                throw ex;
            }
        }
        return null;
    }
}
