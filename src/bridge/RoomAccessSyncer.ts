import { getLogger } from "../logging";
import { IrcBridge } from "./IrcBridge";
import { BridgeRequest } from "../models/BridgeRequest";
import { IrcServer } from "../irc/IrcServer";
import { MatrixRoom } from "matrix-appservice-bridge";
const log = getLogger("RoomAccessSyncer");

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
];

/**
 * This class is supplimentary to the IrcHandler class. This
 * class handles incoming mode changes as well as computing the new
 * power level state.
 */
export class RoomAccessSyncer {
    // Warning: This cache is currently unbounded.
    private powerLevelsForRoom: {
        [roomId: string]: unknown;
    } = {};
    constructor(private ircBridge: IrcBridge) { }

    /**
     * Called when a m.room.power_levels is forwarded to the bridge. This should
     * happen when a Matrix user or the bridge changes the power levels for a room.
     * @param {MatrixEvent} event The matrix event.
     */
    public onMatrixPowerlevelEvent(event: {room_id: string; content: unknown}) {
        this.powerLevelsForRoom[event.room_id] = event.content;
    }

    /**
     * Useful function to determine current power levels. Will either use
     * cached value or fetch from the homeserver.
     * @param {string} roomId The room to fetch the state from.
     */
    private async getCurrentPowerlevels(roomId: string) {
        if (typeof(roomId) !== "string") {
            throw Error("RoomId must be a string");
        }
        if (this.powerLevelsForRoom[roomId]) {
            return this.powerLevelsForRoom[roomId];
        }
        const intent = this.ircBridge.getAppServiceBridge().getIntent();
        try {
            const state = await intent.getStateEvent(roomId, "m.room.power_levels");
            this.powerLevelsForRoom[roomId] = state;
            return state;
        }
        catch (ex) {
            log.warn("Failed to get power levels for ", roomId);
            return null;
        }
    }

    /**
     * Called when an IRC user sets a mode on another user or channel.
     * @param {BridgeReqeust} req The request tracking the operation.
     * @param {IrcServer} server The server the channel and users are part of
     * @param {string} channel Which channel was the mode set in.
     * @param {string} by Which user set the mode
     * @param {string} mode The mode string
     * @param {boolean} enabled Whether the mode was enabled or disabled.
     * @param {string|null} arg This is usually the affected user, if applicable.
     */
    public async onMode(req: BridgeRequest, server: IrcServer, channel: string, by: string,
        mode: string, enabled: boolean, arg: string|null) {
        if (PRIVATE_MODES.includes(mode)) {
            await this.onPrivateMode(req, server, channel, mode, enabled);
            return;
        }

        if (mode === "m") {
            await this.onModeratedChannelToggle(req, server, channel, enabled);
            return;
        }

        // Bridge usermodes to power levels
        const modeToPower = server.getModePowerMap();
        if (!Object.keys(modeToPower).includes(mode)) {
            // Not an operator power mode
            return;
        }

        const nick = arg;
        const matrixRooms = await this.ircBridge.getStore().getMatrixRoomsForChannel(
            server, channel
        );
        if (matrixRooms.length === 0) {
            req.log.info("No mapped matrix rooms for IRC channel %s", channel);
            return;
        }

        // Work out what power levels to give
        const userPowers = [];
        if (modeToPower[mode]) { // only give this power if it's +, not -
            userPowers.push(modeToPower[mode]);
        }
        // Try to also add in other modes for this client connection
        const bridgedClient = nick ? this.ircBridge.getClientPool().getBridgedClientByNick(
            server, nick
        ): undefined;
        let userId = null;
        if (nick !== null && bridgedClient) {
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
            const userPrefixes = chanData.users[nick] as string;

            userPrefixes.split('').forEach(
                prefix => {
                    const m = bridgedClient.unsafeClient.modeForPrefix[prefix];
                    if (modeToPower[m] !== undefined) {
                        userPowers.push(modeToPower[m]);
                    }
                }
            );
        }
        else if (nick) {
            // real IRC user, work out their user ID
            userId = server.getUserIdFromNick(nick);
        }

        if (userId === null) {
            // Probably the BridgeBot or a user we don't know about, drop it.
            return;
        }

        // By default, unset the user's power level. This will be treated
        // as the users_default defined in the power levels (or 0 otherwise).
        let level: number|undefined = undefined;
        // Sort the userPowers for this user in descending order
        // and grab the highest value at the start of the array.
        if (userPowers.length > 0) {
            level = userPowers.sort((a, b) => b - a)[0];
        }

        req.log.info(
            `onMode: Mode ${mode} received for ${nick}, granting level of ` +
            `${enabled ? level : 0} to ${userId}`
        );
        const intent = this.ircBridge.getAppServiceBridge().getIntent();

        for (const room of matrixRooms) {
            const powerLevelMap = await (this.getCurrentPowerlevels(room.getId())) || {};
            const users: {[userId: string]: number} = powerLevelMap.users || {};
            // If the user's present PL is equal to the level,
            // or is 0|undefined and the mode is disabled.
            if ((users[userId] === level && enabled) || !enabled && !users[userId]) {
                req.log.debug("Not granting PLs, user already has correct PL");
                continue;
            }
            // If we have a PL for the user, and the PL is higher than
            // the level we want to give the user.
            if (users[userId] !== undefined && users[userId] > (level || 0)) {
                req.log.debug("Not granting PLs, user has a higher existing PL");
                continue;
            }
            // If we hit here, then level is higher than our current level.
            if (!enabled) {
                // XXX: Annoyingly we don't know if we can pop down to
                // voiced level after being de-oped, as we aren't told the full
                // set of modes.
                level = 0;
            }
            try {
                await intent.setPowerLevel(room.getId(), userId, level);
            }
            catch (ex) {
                req.log.warn(`Failed to apply PL${level} to ${userId}`, ex);
            }
        }

    }
    /**
     * Called when an IRC server responds to a mode request.
     * @param {BridgeRequest} req The request tracking the operation.
     * @param {IrcServer} server The server the channel and users are part of
     * @param {string} channel Which channel was the mode(s) set in.
     * @param {string} mode The mode string, which may contain many modes.
     */
    public async onModeIs(req: BridgeRequest, server: IrcServer, channel: string, mode: string) {
        // Delegate to this.onMode
        const promises = mode.split('').map(
            (modeChar) => {
                if (modeChar === '+') {
                    return Promise.resolve();
                }
                return this.onMode(req, server, channel, 'onModeIs function', modeChar, true, null);
            }
        );

        // We cache modes per room, so extract the set of modes for all these rooms.
        const roomModeMap = await this.ircBridge.getStore().getModesForChannel(server, channel);
        const oldModes = new Set<string>();
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
                return this.onMode(req, server, channel, 'onModeIs function', oldModeChar, false, null);
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
    public async removePowerLevels(roomId: string, users: string[]) {
        if (users.length === 0) {
            return;
        }
        log.info(`Removing power levels for ${users.length} user(s) from ${roomId}`);
        const plContent = await this.getCurrentPowerlevels(roomId);
        if (!plContent) {
            log.warn(`Could not remove power levels for ${roomId} Could not fetch power levels.`);
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
        const botClient = this.ircBridge.getAppServiceBridge().getIntent().getClient();
        await botClient.sendStateEvent(roomId, "m.room.power_levels", plContent, "");
    }

    /**
     * If a mode given in PRIVATE_MODES is found, change a room's join rules
     * to match.
     * @param {BridgeReqeust} req The request tracking the operation.
     * @param {IrcServer} server The server the channel and users are part of
     * @param {string} channel Which channel was the mode(s) set in.
     * @param {string} mode The mode string.
     * @param {boolean} enabled Was the mode enabled or disabled.
     */
    private async onPrivateMode(req: BridgeRequest, server: IrcServer, channel: string,
                                mode: string, enabled: boolean) {
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
        const matrixRooms = await this.ircBridge.getStore().getMatrixRoomsForChannel(
            server, channel
        );
        if (matrixRooms.length === 0) {
            req.log.info("No mapped matrix rooms for IRC channel %s", channel);
            return;
        }

        if (mode === "s") {
            if (!server.shouldPublishRooms()) {
                req.log.info("Not syncing publicity: shouldPublishRooms is false");
                return;
            }
            const key = this.ircBridge.publicitySyncer.getIRCVisMapKey(
                server.getNetworkId(), channel
            );

            matrixRooms.map((room) => {
                this.ircBridge.getStore().setModeForRoom(room.getId(), "s", enabled);
            });
            // Update the visibility for all rooms connected to this channel
            this.ircBridge.publicitySyncer.updateVisibilityMap(
                true, key, enabled
            );
        }
        // "k" and "i"
        await Promise.all(matrixRooms.map((room) =>
            this.ircBridge.getStore().setModeForRoom(room.getId(), mode, enabled)
        ));

        const promises = matrixRooms.map((room) => {
            switch (mode) {
                case "k":
                case "i":
                    req.log.info((enabled ? "Locking room %s" :
                        "Reverting %s back to default join_rule"),
                        room.getId()
                    );
                    if (enabled) {
                        return this.setMatrixRoomAsInviteOnly(room, true);
                    }
                    // don't "unlock"; the room may have been invite
                    // only from the beginning.
                    enabled = server.getJoinRule() === "invite";
                    return this.setMatrixRoomAsInviteOnly(room, enabled);
                default:
                    // Not reachable, but warn anyway in case of future additions
                    req.log.warn(`onMode: Unhandled channel mode ${mode}`);
                    return Promise.resolve();
            }
        });

        await Promise.all(promises);
    }

    /**
     * This is called when a "m" mode is toggled in a channel. This will either
     * enable or disable a users permission to speak unless they are voiced.
     * @param {BridgeReqeust} req The request tracking the operation.
     * @param {IrcServer} server The server the channel and users are part of
     * @param {string} channel Which channel was the mode(s) set in.
     * @param {boolean} enabled Has moderation been turned on or off.
     */
    private async onModeratedChannelToggle(req: BridgeRequest, server: IrcServer, channel: string, enabled: boolean) {
        const ircStore = this.ircBridge.getStore();
        const matrixRooms = await ircStore.getMatrixRoomsForChannel(server, channel);
        // modify power levels for all mapped rooms to set events_default
        // to something >0 so by default people CANNOT speak into it (unless they
        // are a mod or have voice, both of which need to be configured correctly in
        // the config file).
        const botClient = this.ircBridge.getAppServiceBridge().getIntent().getClient();
        for (const room of matrixRooms) {
            req.log.info(`Checking moderated status for ${channel}`);
            const roomId = room.getId();
            try {
                const plContent = await this.getCurrentPowerlevels(roomId);
                const eventsDefault = enabled ? 1 : 0;
                if (plContent.events_default === eventsDefault) {
                    req.log.debug(`${channel} already has events_default set to ${eventsDefault}`);
                    continue;
                }
                plContent.events_default = eventsDefault;
                await botClient.sendStateEvent(roomId, "m.room.power_levels", plContent, "");
                req.log.info(
                "onModeratedChannelToggle: (channel=%s,enabled=%s) power levels updated in room %s",
                channel, enabled, roomId
                );
                ircStore.setModeForRoom(roomId, "m", enabled);
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
    private async setMatrixRoomAsInviteOnly(room: MatrixRoom, isInviteOnly: boolean) {
        const client = this.ircBridge.getAppServiceBridge().getIntent().getClient();
        return client.sendStateEvent(
            room.getId(),
            "m.room.join_rules", {
                join_rule: (isInviteOnly ? "invite" : "public")
            },
            ""
        );
    }
}
