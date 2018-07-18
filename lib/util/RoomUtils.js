class RoomUtils {
    /**
     * Get the default power levels object that should be set for portal rooms.
     * @param {string} oPowerfulOne UserId of the user who should recieve PL100 for the room.
     */
    static GetPortalPowerlevels(oPowerfulOne) {
        const users = { };
        users[oPowerfulOne] = 100;
        return {
            users,
            redact: 50,
            invite: 0,
            ban: 50,
            events: {
                "m.room.avatar": 50,
                "m.room.history_visibility": 50,
                "m.room.canonical_alias": 50,
                "m.room.name": 50,
                "m.room.power_levels": 100,
                "m.room.encryption": 100,
            },
            kick: 50,
            state_default: 50,
            events_default: 0,
            users_default: 0,
        }
    }
}

module.exports = RoomUtils;