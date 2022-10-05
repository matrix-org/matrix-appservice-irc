import logger from "../logging";
import { IrcBridge } from "./IrcBridge";
import { IrcServer } from "../irc/IrcServer";
import { Queue } from "../util/Queue";

const log = logger("PublicitySyncer");

// This class keeps the +s state of every channel bridged synced with the RoomVisibility
// of any rooms that are connected to the channels, regardless of the number of hops
// required to traverse the mapping graph (rooms to channels).
//
// NB: This is only in the direction I->M
//
// +s = 'private'
// -s = 'public'
// Modes received, but +s missing = 'public'

export class PublicitySyncer {

    // Cache the mode of each channel, the visibility of each room and the
    // known mappings between them. When any of these change, any inconsistencies
    // should be resolved by keeping the matrix side as private as necessary
    private visibilityMap: {
        mappings: {
            [roomId: string]: string[];
        };
        channelIsSecret: {
            [networkIdChannel: string]: boolean;
            // '$networkId $channel': true | false
        };
        roomVisibilities: {
            [roomId: string]: "private"|"public";
        };
    } = { mappings: {}, channelIsSecret: {}, roomVisibilities: {} };

    private initModeQueue: Queue<{server: IrcServer; channel: string}>;
    constructor (private ircBridge: IrcBridge) {
        this.initModeQueue = new Queue(this.initModeForChannel.bind(this));
    }

    public async initModeForChannel(opts: {server: IrcServer; channel: string}) {
        try {
            const botClient = await this.ircBridge.getBotClient(opts.server);
            log.info(`Bot requesting mode for ${opts.channel} on ${opts.server.domain}`);
            await botClient.mode(opts.channel);
        }
        catch (err) {
            log.error(`Could not request mode of ${opts.channel} (${err.message})`);
        }
    }

    public async initModes (server: IrcServer) {
        //Get all channels and call modes for each one

        const channels = await this.ircBridge.getStore().getTrackedChannelsForServer(server.domain);
        await Promise.all(channels.map((channel) =>
            this.initModeQueue.enqueue(`${channel}@${server.domain}`, {
                channel,
                server,
            })
        ));
    }

    /**
     * Returns the key used when calling `updateVisibilityMap` for updating an IRC channel
     * visibility mode (+s or -s).
     * ```
     * // Set channel on server to be +s
     * const key = publicitySyncer.getIRCVisMapKey(server.getNetworkId(), channel);
     * publicitySyncer.updateVisibilityMap(true, key, true);
     * ```
     * @param {string} networkId
     * @param {string} channel
     * @returns {string}
     */
    public getIRCVisMapKey(networkId: string, channel: string) {
        return `${networkId} ${channel}`;
    }

    public updateVisibilityMap(isMode: boolean, key: string, value: boolean, channel: string, server: IrcServer) {
        log.debug(`updateVisibilityMap: isMode:${isMode} k:${key} v:${value} chan:${channel} srv:${server.domain}`);
        let hasChanged = false;
        if (isMode) {
            if (typeof value !== 'boolean') {
                throw new Error('+s state must be indicated with a boolean');
            }
            if (this.visibilityMap.channelIsSecret[key] !== value) {
                this.visibilityMap.channelIsSecret[key] = value;
                hasChanged = true;
            }
        }
        else {
            if (typeof value !== 'string' || (value !== "private" && value !== "public")) {
                throw new Error('Room visibility must = "private" | "public"');
            }

            if (this.visibilityMap.roomVisibilities[key] !== value) {
                this.visibilityMap.roomVisibilities[key] = value;
                hasChanged = true;
            }
        }

        if (hasChanged) {
            this.solveVisibility(channel, server).catch((err: Error) => {
                log.error(`Failed to sync publicity for ${channel}: ` + err.message);
            });
        }
    }

    /* Solve any inconsistencies between the currently known state of channels '+s' modes
       and rooms 'visibility' states. This does full graph traversal to prevent any +s
       channels ever escaping into a 'public' room. This function errs on the side of
       caution by assuming an unknown channel state is '+s'. This just means that if the
       modes of a channel are not received yet (e.g when no virtual user is in said channel)
       then the room is assumed secret (+s).

       The bare minimum is done to make sure no private channels are leaked into public
       matrix rooms. If ANY +s channel is somehow being bridged into a room, that room
       is updated to private. If ALL channels somehow being bridged into a room are NOT +s,
       that room is allowed to be public.
    */
    private async solveVisibility (channel: string, server: IrcServer) {
        log.debug(`Solving visibility for ${channel} ${server.domain}`);
        const visKey = this.getIRCVisMapKey(server.getNetworkId(), channel);
        // For each room, do a big OR on all of the channels that are linked in any way
        const mappings = await this.ircBridge.getStore().getMatrixRoomsForChannel(server, channel);
        const roomIds = mappings.map((m) => m.getId());

        this.visibilityMap.mappings = {};

        // Update rooms to correct visibilities
        let currentStates: {[roomId: string]: "public"|"private"} = {};

        // Assume private by default
        roomIds.forEach((r) => { currentStates[r] = "private" });

        currentStates = {
            ...currentStates,
            ...await this.ircBridge.getStore().getRoomsVisibility(roomIds),
        };

        const correctState = this.visibilityMap.channelIsSecret[visKey] ? 'private' : 'public';

        log.info(`Solved visibility rules for ${channel} (${server.domain}): ${correctState}`);

        return Promise.all(roomIds.map(async (roomId) => {
            const currentState = currentStates[roomId];

            // Use the server network ID of the first mapping
            // 'funNetwork #channel1' => 'funNetwork'

            if (currentState === correctState) {
                return;
            }
            try {
                const intent = this.ircBridge.getAppServiceBridge().getIntent();
                if (server.shouldPublishRoomsToHomeserverDirectory()) {
                    await intent.setRoomDirectoryVisibility(roomId, correctState);
                }
                else {
                    await intent.setRoomDirectoryVisibilityAppService(roomId, server.getNetworkId(), correctState);
                }
                await this.ircBridge.getStore().setRoomVisibility(roomId, correctState);
                // Update cache
                this.visibilityMap.roomVisibilities[roomId] = correctState;
            }
            catch (ex) {
                log.error(`Failed to setRoomDirectoryVisibility (${ex.message})`);
            }
        }));
    }
}
