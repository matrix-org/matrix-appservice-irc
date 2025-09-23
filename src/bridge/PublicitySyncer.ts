import logger from "../logging";
import { IrcBridge } from "./IrcBridge";
import { MatrixDirectoryVisibility } from "../bridge/IrcHandler";
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
    // should be resolved by keeping the Matrix side as private as necessary.
    private visibilityMap: {
        // key: Matrix Room ID
        mappings: Map<string, string[]>,
        // key: '$networkId $channel'
        channelIsSecret: Map<string, boolean>,
        // key: Matrix Room ID
        roomVisibilities: Map<string, MatrixDirectoryVisibility>,
    } = { mappings: new Map(), channelIsSecret: new Map(), roomVisibilities: new Map() };

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
        log.info(`Syncing modes for ${channels.length} on ${server.domain}`);
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
     * @param {string} networkId
     * @param {string} channel
     * @returns {string}
     */
    private getIRCVisMapKey(networkId: string, channel: string) {
        return `${networkId} ${channel}`;
    }

    /**
     * Update the visibility of a given channel
     *
     * @param isSecret Is the channel secret.
     * @param channel Channel name
     * @param server Server the channel is part of.
     * @returns If the channel publicity was synced.
     */
    public async updateVisibilityMap(channel: string, server: IrcServer, isSecret: boolean): Promise<boolean> {
        const key = this.getIRCVisMapKey(server.getNetworkId(), channel);
        log.debug(`updateVisibilityMap ${key} isSecret:${isSecret}`);
        let hasChanged = false;
        if (this.visibilityMap.channelIsSecret.get(key) !== isSecret) {
            this.visibilityMap.channelIsSecret.set(key, isSecret);
            hasChanged = true;
        }

        if (hasChanged) {
            try {
                await this.solveVisibility(channel, server)
            }
            catch (err) {
                throw Error(`Failed to sync publicity for ${channel}: ${err.message}`);
            }
        }
        return hasChanged;
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

        this.visibilityMap.mappings = new Map();

        // Update rooms to correct visibilities
        const currentStates: Map<string, MatrixDirectoryVisibility>
            = await this.ircBridge.getStore().getRoomsVisibility(roomIds);

        const correctState = this.visibilityMap.channelIsSecret.get(visKey) ? 'private' : 'public';

        log.info(`Solved visibility rules for ${channel} (${server.domain}): ${correctState}`);

        return Promise.all(roomIds.map(async (roomId) => {
            const currentState = currentStates.get(roomId);

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
                this.visibilityMap.roomVisibilities.set(roomId, correctState);
            }
            catch (ex) {
                log.error(`Failed to setRoomDirectoryVisibility (${ex.message})`);
            }
        }));
    }
}
