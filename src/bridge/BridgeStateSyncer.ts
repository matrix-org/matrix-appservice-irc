import { DataStore } from "../datastore/DataStore";
import { QueuePool } from "../util/QueuePool";
import { Bridge } from "matrix-appservice-bridge";
import logging from "../logging";
import { IrcBridge } from "./IrcBridge";
import { IrcServer } from "../irc/IrcServer";

const log = logging("BridgeStateSyncer");

const SYNC_CONCURRENCY = 3;
const BRIDGE_LINE_LIMIT = 200;

interface QueueItem {
    roomId: string;
    mappings: Array<{networkId: string; channel: string}>;
}

/**
 * This class will set bridge room state according to [MSC2346](https://github.com/matrix-org/matrix-doc/pull/2346)
 */
export class BridgeStateSyncer {
    public static readonly EventType = "uk.half-shot.bridge";
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
                const eventData = await this.getStateEvent(item.roomId, BridgeStateSyncer.EventType, key);
                if (eventData !== null) { // If found, validate.
                    const expectedContent = this.createBridgeInfoContent(
                        mapping.networkId, mapping.channel
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
            const eventContent = this.createBridgeInfoContent(mapping.networkId, mapping.channel);
            const owner = await this.determineProvisionedOwner(item.roomId, mapping.networkId, mapping.channel);
            eventContent.creator = owner || undefined;
            try {
                await intent.sendStateEvent(item.roomId, BridgeStateSyncer.EventType, key, eventContent);
            }
            catch (ex) {
                log.error(`Failed to update room with new state content: ${ex.message}`);
            }
        }
    }

    public createInitialState(server: IrcServer, channel: string, owner?: string) {
        return {
            type: BridgeStateSyncer.EventType,
            content: this.createBridgeInfoContent(server, channel, owner),
            state_key: BridgeStateSyncer.createStateKey(server.domain, channel)
        };
    }

    public static createStateKey(networkId: string, channel: string) {
        networkId = networkId.replace(/\//g, "%2F");
        channel = channel.replace(/\//g, "%2F");
        return `org.matrix.appservice-irc://irc/${networkId}/${channel}`
    }

    public createBridgeInfoContent(networkIdOrServer: string|IrcServer, channel: string, creator?: string) {
        const server = typeof(networkIdOrServer) === "string" ?
            this.ircBridge.getServer(networkIdOrServer) : networkIdOrServer;
        if (!server) {
            throw Error("Server not known");
        }
        const serverName = server.getReadableName();
        return {
            creator: creator, // Is this known?
            protocol: {
                id: "irc",
                displayname: "IRC",
            },
            network: {
                id: server.domain,
                displayname: serverName,
            },
            channel: {
                id: channel,
                external_url: `irc://${server.domain}/${channel}`
            },
            limitations: {
                "org.matrix.message-length": {
                    limit: BRIDGE_LINE_LIMIT,
                },
            },
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
