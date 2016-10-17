/*eslint no-invalid-this: 0*/ // eslint doesn't understand Promise.coroutine wrapping
"use strict";
var Promise = require("bluebird");
var log = require("../logging").get("PublicitySyncer");

// This class keeps the +s state of every channel bridged synced with the RoomVisibility
// of any rooms that are connected to the channels, regardless of the number of hops
// required to traverse the mapping graph (rooms to channels).
//
// NB: This is only in the direction I->M
//
// +s = 'private'
// -s = 'public'
// Modes received, but +s missing = 'public'
function PublicitySyncer(ircBridge) {
    this.ircBridge = ircBridge;

    // Cache the mode of each channel, the visibility of each room and the
    // known mappings between them. When any of these change, any inconsistencies
    // should be resolved by keeping the matrix side as private as necessary
    this._visibilityMap = {
        mappings: {
            //room_id: ['server #channel1', 'server channel2',...]
        },
        channelIsSecret: {
            // '$server $channel': true | false
        },
        roomVisibilities: {
            // room_id: "private" | "public"
        }
    }
}

PublicitySyncer.prototype.initModeForChannel = function(server, chan) {
    return this.ircBridge.getBotClient(server).then(
        (client) => {
            if (!client.unsafeClient) {
                log.error(`Can't request modes, bot client not connected`);
            }
            log.info(`Bot requesting mode for ${chan} on ${server.domain}`);
            client.unsafeClient.mode(chan);
        },
        (err) => {
            log.error(`Could not request mode of ${chan} (${err.message})`);
        }
    );
}

PublicitySyncer.prototype.initModes = Promise.coroutine(function*(server) {
    //Get all channels and call modes for each one

    let channels = yield this.ircBridge.getStore().getTrackedChannelsForServer(server.domain);

    channels = new Set(channels);

    channels.forEach((chan) => {
        // Request mode for channel
        this.initModeForChannel(server, chan).catch((err) => {
            log.error(err.stack);
        });
    });
});

// This is used so that any updates to the visibility map will cause the syncer to
// reset a timer and begin counting down again to the eventual call to solve any
// inconsistencies in the visibility map.
var solveVisibilityTimeoutId = null;

PublicitySyncer.prototype.updateVisibilityMap = function(isMode, key, value) {
    let hasChanged = false;
    if (isMode) {
        if (typeof value !== 'boolean') {
            throw new Error('+s state must be indicated with a boolean');
        }
        if (this._visibilityMap.channelIsSecret[key] !== value) {
            this._visibilityMap.channelIsSecret[key] = value;
            hasChanged = true;
        }
    }
    else {
        if (typeof value !== 'string' || (value !== "private" && value !== "public")) {
            throw new Error('Room visibility must = "private" | "public"');
        }

        if (this._visibilityMap.roomVisibilities[key] !== value) {
            this._visibilityMap.roomVisibilities[key] = value;
            hasChanged = true;
        }
    }

    if (hasChanged) {
        clearTimeout(solveVisibilityTimeoutId);

        solveVisibilityTimeoutId = setTimeout(() => {
            this._solveVisibility().catch((err) => {
                log.error("Failed to sync publicity: " + err.message);
            });
        }, 10000);
        return Promise.resolve();
    }

    return Promise.resolve();
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
PublicitySyncer.prototype._solveVisibility = Promise.coroutine(function*() {
    // For each room, do a big OR on all of the channels that are linked in any way

    let mappings = yield this.ircBridge.getStore().getAllChannelMappings();

    let roomIds = Object.keys(mappings);

    this._visibilityMap.mappings = {};

    roomIds.forEach((roomId) => {
        this._visibilityMap.mappings[roomId] = mappings[roomId].map((mapping) => {
            return mapping.domain + ' ' + mapping.channel
        });
    });

    let shouldBePrivate = (roomId, checkedChannels) => {
        // If any channel connected to this room is +s, stop early and call it private

        // List first connected
        let channels = this._visibilityMap.mappings[roomId];
        //      = ['localhost #channel1', 'localhost #channel2', ... ]

        // No channels mapped to this roomId
        if (!channels) {
            return false;
        }

        // Filter out already checked channels
        channels = channels.filter((c) => checkedChannels.indexOf(c) === -1);

        let anyAreSecret = channels.some((channel) => {
            let channelIsSecret = this._visibilityMap.channelIsSecret[channel];

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
            return Object.keys(this._visibilityMap.mappings).filter((roomId2) => {
                return this._visibilityMap.mappings[roomId2].indexOf(channel) !== -1;
            });
        }).some((roomIds2) => {
            return roomIds2.some((roomId2) => {
                return shouldBePrivate(roomId2, checkedChannels.concat(channels));
            });
        });
    }

    let cli = this.ircBridge._bridge.getBot().client;

    // Update rooms to correct visibilities
    let promises = roomIds.map((roomId, index) => {
        let currentState = this._visibilityMap.roomVisibilities[roomId];
        let correctState = shouldBePrivate(roomId, []) ? 'private' : 'public';

        if (currentState !== correctState) {
            return cli.setRoomDirectoryVisibility(roomId, correctState).then(
                () => {
                    // Update cache
                    this._visibilityMap.roomVisibilities[roomId] = correctState;
                }
            ).catch((e) => {
                log.error(`Failed to setRoomDirectoryVisibility (${e.message})`);
            });
        }
    });

    return Promise.all(promises);
});

module.exports = PublicitySyncer;
