import logger from "../logging";
import { IrcBridge } from "./IrcBridge";
import { IrcServer } from "../irc/IrcServer";
import { BridgedClientStatus } from "../irc/BridgedClient";

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

    // This is used so that any updates to the visibility map will cause the syncer to
    // reset a timer and begin counting down again to the eventual call to solve any
    // inconsistencies in the visibility map.
    private solveVisibilityTimeoutId: NodeJS.Timer|null = null;

    // Cache the mode of each channel, the visibility of each room and the
    // known mappings between them. When any of these change, any inconsistencies
    // should be resolved by keeping the matrix side as private as necessary
    private visibilityMap: {
        mappings: {
            [roomId: string]: string[];
        };
        networkToRooms: {
            [networkId: string]: string[];
        };
        channelIsSecret: {
            [networkId: string]: boolean;
            // '$networkId $channel': true | false
        };
        roomVisibilities: {
            [roomId: string]: "private"|"public";
        };
    } = {
        mappings: {},
        networkToRooms: {},
        channelIsSecret: {},
        roomVisibilities: {},
    };
    constructor (private ircBridge: IrcBridge) { }

    public initModeForChannel(server: IrcServer, chan: string) {
        return this.ircBridge.getBotClient(server).then(
            (client) => {
                if (client.state.status !== BridgedClientStatus.CONNECTED) {
                    throw Error("Can't request modes, bot client not connected")
                }
                log.info(`Bot requesting mode for ${chan} on ${server.domain}`);
                client.state.client.mode(chan);
            },
            (err) => {
                log.error(`Could not request mode of ${chan} (${err.message})`);
            }
        );
    }

    public async initModes (server: IrcServer) {
        //Get all channels and call modes for each one

        const channels = await this.ircBridge.getStore().getTrackedChannelsForServer(server.domain);

        await Promise.all([...new Set(channels)].map((chan) => {
            // Request mode for channel
            return this.initModeForChannel(server, chan).catch((err) => {
                log.error(err.stack);
            });
        }));
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

    public updateVisibilityMap(isMode: boolean, key: string, value: boolean) {
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
            if (this.solveVisibilityTimeoutId) {
                clearTimeout(this.solveVisibilityTimeoutId);
            }

            this.solveVisibilityTimeoutId = setTimeout(() => {
                this.solveVisibility().catch((err: Error) => {
                    log.error("Failed to sync publicity: " + err.message);
                });
            }, 10000);
        }
    }

    /* Solve any inconsistencies between the currently known state of channels '+s' modes
       and rooms 'visibility' states. This does full graph traversal to prevent any +s
       channels ever escaping into a 'public' room. This function errs on the side of
       caution by assuming an unknown channel state is '+s'. This just means that if the
       modes of a channel are not received yet (e.g when no virtual user is in said channel)
       then the room is assumed secret (+s).

       The bare minimum is done to make sure no private channels are leaked into public
       matrix channels. If ANY +s channel is somehow being bridged into a room, that room
       is updated to private. If ALL channels somehow being bridged into a room are NOT +s,
       that room is allowed to be public.
    */
    private async solveVisibility () {
        // For each room, do a big OR on all of the channels that are linked in any way
        const mappings = await this.ircBridge.getStore().getAllChannelMappings();
        const roomIds = Object.keys(mappings);

        this.visibilityMap.mappings = {};

        roomIds.forEach((roomId) => {
            this.visibilityMap.mappings[roomId] = mappings[roomId].map((mapping) => {
                const key = this.getIRCVisMapKey(mapping.networkId, mapping.channel);
                // also assign reverse mapping for lookup speed later
                if (!this.visibilityMap.networkToRooms[key]) {
                    this.visibilityMap.networkToRooms[key] = [];
                }
                this.visibilityMap.networkToRooms[key].push(roomId);
                return key;
            });
        });

        const shouldBePrivate = (roomId: string, checkedChannels: string[]): boolean => {
            // If any channel connected to this room is +s, stop early and call it private

            // List first connected
            let channels = this.visibilityMap.mappings[roomId];
            //      = ['localhost #channel1', 'localhost #channel2', ... ]

            // No channels mapped to this roomId
            if (!channels) {
                return false;
            }

            // Filter out already checked channels
            channels = channels.filter((c) => checkedChannels.indexOf(c) === -1);

            const anyAreSecret = channels.some((channel) => {
                let channelIsSecret = this.visibilityMap.channelIsSecret[channel];

                // If a channel mode is unknown, assume it is secret
                if (typeof channelIsSecret === 'undefined') {
                    log.info('Assuming channel ' + channel + ' is secret');
                    channelIsSecret = true;
                }

                return channelIsSecret;
            });
            if (anyAreSecret) {
                return true;
            }

            // Otherwise, recurse with the rooms connected to each channel

            // So get all the roomIds that this channel is mapped to and return whether any
            //  are mapped to channels that are secret
            return channels.map((channel) => {
                return this.visibilityMap.networkToRooms[channel] || [];
            }).some((roomIds2) => {
                return roomIds2.some((roomId2) => {
                    return shouldBePrivate(roomId2, checkedChannels.concat(channels));
                });
            });
        }

        const cli = this.ircBridge.getAppServiceBridge().getBot().getClient();
        // Update rooms to correct visibilities
        let currentStates: {[roomId: string]: string} = {};

        // Assume private by default
        roomIds.forEach((r) => { currentStates[r] = "private" });

        currentStates = {
            ...currentStates,
            ...await this.ircBridge.getStore().getRoomsVisibility(roomIds),
        };

        const promises = roomIds.map(async (roomId) => {
            const currentState = currentStates[roomId];
            const correctState: "private"|"public" = shouldBePrivate(roomId, []) ? 'private' : 'public';

            // Use the server network ID of the first mapping
            // 'funNetwork #channel1' => 'funNetwork'
            const networkId = this.visibilityMap.mappings[roomId][0].split(' ')[0];

            if (currentState !== correctState) {
                try {
                    await cli.setRoomDirectoryVisibilityAppService(networkId, roomId, correctState);
                    await this.ircBridge.getStore().setRoomVisibility(roomId, correctState);
                    // Update cache
                    this.visibilityMap.roomVisibilities[roomId] = correctState;
                }
                catch (ex) {
                    log.error(`Failed to setRoomDirectoryVisibility (${ex.message})`);
                }
            }
        });

        return Promise.all(promises);
    }
}
