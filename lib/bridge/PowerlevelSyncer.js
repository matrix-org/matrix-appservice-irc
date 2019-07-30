const log = require("../logging").get("PowerlevelSyncer");

const MODES_TO_WATCH = [
    "m", // This channel is "moderated" - only voiced users can speak.
         // We want to ensure we do not miss rooms that get unmoderated.
    "k", // keylock - needs a password
    "i", // invite only
    "s", // secret - don't show in channel lisitings
];

const PRIVATE_MODES = [
    "k",
    "i",
    "s",
]

/**
 * This class is supplimentary to the IrcHandler class. This
 * class handles incoming mode changes as well as computing the new
 * power level state.
 */
class PowerlevelSyncer {

    constructor(ircBridge) {
        this._ircBridge = ircBridge;
        this._powerLevelsForRoom = {
            // roomId:PowerLevelObject
        };
    }

    onMatrixPowerlevelEvent(event) {
        this._powerLevelsForRoom[event.room_id] = event.content;
    }

    async onMode(req, server, channel, by, mode, enabled, arg) {
        if (PRIVATE_MODES.includes(mode)) {
            await this._onPrivateMode(req, server, channel, by, mode, enabled, arg);
            return;
        }

        if (mode === "m") {
            await this._onModeratedChannelToggle(req, server, channel, by, enabled, arg);
            return;
        }

        // Bridge usermodes to power levels
        const modeToPower = server.getModePowerMap();
        if (!Object.keys(modeToPower).includes(mode)) {
            // Not an operator power mode
            return;
        }

        const nick = arg;
        const matrixRooms = await this._ircBridge.getStore().getMatrixRoomsForChannel(
            server, channel
        );
        if (matrixRooms.length === 0) {
            req.log.info("No mapped matrix rooms for IRC channel %s", channel);
            return;
        }

        // Work out what power levels to give
        const userPowers = [];
        if (modeToPower[mode] && enabled) { // only give this power if it's +, not -
            userPowers.push(modeToPower[mode]);
        }

        // Try to also add in other modes for this client connection
        const bridgedClient = this._ircBridge.getClientPool().getBridgedClientByNick(
            server, nick
        );
        let userId = null;
        if (bridgedClient) {
            userId = bridgedClient.userId;
            if (!bridgedClient.unsafeClient) {
                req.log.info(`Bridged client for ${nick} has no IRC client.`);
                return;
            }
            const chanData = bridgedClient.unsafeClient.chanData(channel);
            if (!(chanData && chanData.users)) {
                req.log.error(`No channel data for ${channel}`);
                return;
            }
            const userPrefixes = chanData.users[nick];

            userPrefixes.split('').forEach(
                prefix => {
                    const m = bridgedClient.unsafeClient.modeForPrefix[prefix];
                    if (modeToPower[m] !== undefined) {
                        userPowers.push(modeToPower[m]);
                    }
                }
            );
        }
        else {
            // real IRC user, work out their user ID
            userId = server.getUserIdFromNick(nick);
        }

        // By default, unset the user's power level. This will be treated
        // as the users_default defined in the power levels (or 0 otherwise).
        let level = undefined;
        // Sort the userPowers for this user in descending order
        // and grab the highest value at the start of the array.
        if (userPowers.length > 0) {
            level = userPowers.sort((a, b) => b - a)[0];
        }

        req.log.info(
            `onMode: Mode ${mode} received for ${nick} - granting level of ${level} to ${userId}`
        );

        const promises = matrixRooms.map((room) => {
            return this._ircBridge.getAppServiceBridge().getIntent()
                .setPowerLevel(room.getId(), userId, level);
        });

        await Promise.all(promises);
    }

    async onModeIs(req, server, channel, mode) {
        // Delegate to this.onMode
        let promises = mode.split('').map(
            (modeChar) => {
                if (modeChar === '+') {
                    return Promise.resolve();
                }
                return this.onMode(req, server, channel, 'onModeIs function', modeChar, true);
            }
        );

        // We cache modes per room, so extract the set of modes for all these rooms.
        const roomModeMap = await this._ircBridge.getStore().getModesForChannel(server, channel);
        const oldModes = new Set();
        Object.values(roomModeMap).forEach((roomMode) => {
            roomMode.forEach((m) => {oldModes.add(m)});
        });
        req.log.debug(`Got cached mode for ${channel} ${[...oldModes]}`);

        // For each cached mode we have for the room, that is no longer set: emit a disabled mode.
        promises.concat([...oldModes].map((oldModeChar) => {
            if (!MODES_TO_WATCH.includes(oldModeChar)) {
                return Promise.resolve();
            }
            req.log.debug(
                `${server.domain} ${channel}: Checking if '${oldModeChar}' is still set.`
            );
            if (!mode.includes(oldModeChar)) { // If the mode is no longer here.
                req.log.debug(`${oldModeChar} has been unset, disabling.`);
                return this.onMode(req, server, channel, 'onModeIs function', oldModeChar, false);
            }
            return Promise.resolve();
        }));

        await Promise.all(promises);
    }

    /**
     * Bulk remove a set of users permissions from a room. If users is empty
     * or no changes were made, this will no-op.
     * @param {string} roomId A roomId
     * @param {string[]} users A set of userIds
     */
    async removePowerLevels(roomId, users) {
        if (users.length === 0) {
            return;
        }
        log.info(`Removing power levels for ${users.length} user(s) from ${roomId}`);
        const plContent = await this._getCurrentPowerlevels(roomId);
        if (!plContent) {
            log.warn("Could not remove power levels for", roomId, ". Could not fetch power levels.");
            return;
        }
        let modified = 0;
        for (const userId of users) {
            if (plContent.users[userId] !== undefined) {
                delete plContent.users[userId];
                modified++;
            }
        }
        if (modified === 0) {
            // We didn't actually change anything, so don't send anything.
            return;
        }
        const botClient = this._ircBridge.getAppServiceBridge().getIntent().getClient();
        await botClient.sendStateEvent(roomId, "m.room.power_levels", plContent, "");
    }
        // 'k' = Channel requires 'keyword' to join.
        // 'i' = Channel is invite-only.
        // 's' = Channel is secret

        // For k and i, we currently want to flip the join_rules to be
        // 'invite' to prevent new people who are not in the room from
        // joining.

        // For s, we just want to control the room directory visibility
        // accordingly. (+s = 'private', -s = 'public')

        // TODO: Add support for specifying the correct 'keyword' and
        // support for sending INVITEs for virtual IRC users.
        let matrixRooms = await this._ircBridge.getStore().getMatrixRoomsForChannel(server, channel);
        if (matrixRooms.length === 0) {
            req.log.info("No mapped matrix rooms for IRC channel %s", channel);
            return;
        }

        if (mode === "s") {
            if (!server.shouldPublishRooms()) {
                req.log.info("Not syncing publicity: shouldPublishRooms is false");
                return;
            }
            const key = this._ircBridge.publicitySyncer.getIRCVisMapKey(server.getNetworkId(), channel);

            matrixRooms.map((room) => {
                this._ircBridge.getStore().setModeForRoom(room.getId(), "s", enabled);
            });
            // Update the visibility for all rooms connected to this channel
            await this._ircBridge.publicitySyncer.updateVisibilityMap(
                true, key, enabled
            );
        }
        // "k" and "i"
        matrixRooms.map((room) => {
            this._ircBridge.getStore().setModeForRoom(room.getId(), mode, enabled);
        });

        const promises = matrixRooms.map((room) => {
            switch (mode) {
                case "k":
                case "i":
                    req.log.info((enabled ? "Locking room %s" :
                        "Reverting %s back to default join_rule"),
                        room.getId()
                    );
                    if (enabled) {
                        return this._setMatrixRoomAsInviteOnly(room, true);
                    }
                    // don't "unlock"; the room may have been invite
                    // only from the beginning.
                    enabled = server.getJoinRule() === "invite";
                    return this._setMatrixRoomAsInviteOnly(room, enabled);
                default:
                    // Not reachable, but warn anyway in case of future additions
                    req.log.warn(`onMode: Unhandled channel mode ${mode}`);
                    return Promise.resolve();
            }
        });

        await Promise.all(promises);
    }

    async _onModeratedChannelToggle(req, server, channel, by, enabled, arg) {
        const matrixRooms = await this._ircBridge.getStore().getMatrixRoomsForChannel(server, channel);
        // modify power levels for all mapped rooms to set events_default to something >0 so by default
        // people CANNOT speak into it (unless they are a mod or have voice, both of which need to be
        // configured correctly in the config file).
        const botClient = this.ircBridge.getAppServiceBridge().getIntent().getClient();
        for (let i = 0; i < matrixRooms.length; i++) {
            const roomId = matrixRooms[i].getId();
            try {
                const plContent = await botClient.getStateEvent(roomId, "m.room.power_levels", "");
                plContent.events_default = enabled ? 1 : 0;
                await botClient.sendStateEvent(roomId, "m.room.power_levels", plContent, "");
                req.log.info(
                    "onModeratedChannelToggle: (channel=%s,enabled=%s) power levels updated in room %s",
                    channel, enabled, roomId
                );
                this.ircBridge.getStore().setModeForRoom(roomId, "m", enabled);
            }
            catch (err) {
                req.log.error("Failed to alter power level in room %s : %s", roomId, err);
            }
        }
    }

    /**
     * Modify the join rules of a room, setting it either to invite only or public.
     * @param {MatrixRoom} room The room to set the join_rules for.
     * @param {boolean} isInviteOnly Set to true to make invite only, set to false to
     *                               make the room public
     */
    async _setMatrixRoomAsInviteOnly(room, isInviteOnly) {
        return this.ircBridge.getAppServiceBridge().getClientFactory().getClientAs().sendStateEvent(
            room.getId(),
            "m.room.join_rules", {
                join_rule: (isInviteOnly ? "invite" : "public")
            },
            ""
        );
    }

    computePowerlevelForUser() {

    }
}

module.exports = PowerlevelSyncer;
