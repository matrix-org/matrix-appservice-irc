/*eslint no-invalid-this: 0*/ // eslint doesn't understand Promise.coroutine wrapping

// Controls the logic for determining which membership lists should be synced and
// handles the sequence of events until the lists are in sync.
"use strict";

var Promise = require("bluebird");
var promiseutil = require("../promiseutil");
var log = require("../logging").get("MemberListSyncer");

function MemberListSyncer(ircBridge, appServiceBot, server, appServiceUserId, injectJoinFn) {
    this.ircBridge = ircBridge;
    this.appServiceBot = appServiceBot;
    this.server = server;
    this.appServiceUserId = appServiceUserId;
    this.injectJoinFn = injectJoinFn;
    this._syncableRoomsPromise = null;
}

MemberListSyncer.prototype.sync = Promise.coroutine(function*() {
    let server = this.server;
    if (!server.isMembershipListsEnabled()) {
        log.info("%s does not have membership list syncing enabled.", server.domain);
        return;
    }
    if (!server.shouldSyncMembershipToIrc("initial")) {
        log.info("%s shouldn't sync initial memberships to irc.", server.domain);
        return;
    }
    log.info("Checking membership lists for syncing on %s", server.domain);
    let start = Date.now();
    let rooms = yield this._getSyncableRooms(server);
    log.info("Found %s syncable rooms (%sms)", rooms.length, Date.now() - start);
    start = Date.now();
    log.info("Joining Matrix users to IRC channels...");
    yield joinMatrixUsersToChannels(rooms, server, this.injectJoinFn);
    log.info("Joined Matrix users to IRC channels. (%sms)", Date.now() - start);
    // NB: We do not need to explicitly join IRC users to Matrix rooms
    // because we get all of the NAMEs/JOINs as events when we connect to
    // the IRC server. This effectively "injects" the list for us.
    start = Date.now();
    log.info("Leaving IRC users from Matrix rooms (cleanup)...");
    yield leaveIrcUsersFromRooms(rooms, server);
    log.info("Left IRC users from Matrix rooms. (%sms)", Date.now() - start);
});

MemberListSyncer.prototype.getChannelsToJoin = Promise.coroutine(function*() {
    let server = this.server;
    log.debug("getChannelsToJoin => %s", server.domain);
    let rooms = yield this._getSyncableRooms(server);

    // map room IDs to channels on this server.
    let channels = new Set();
    let roomInfoMap = {};
    let roomIds = rooms.map((roomInfo) => {
        roomInfoMap[roomInfo.id] = roomInfo;
        return roomInfo.id;
    });
    yield this.ircBridge.getStore().getIrcChannelsForRoomIds(roomIds).then((roomIdToIrcRoom) => {
        Object.keys(roomIdToIrcRoom).forEach((roomId) => {
            // only interested in rooms for this server
            let ircRooms = roomIdToIrcRoom[roomId].filter((ircRoom) => {
                return ircRoom.server.domain === server.domain;
            });
            ircRooms.forEach((ircRoom) => {
                channels.add(ircRoom.channel);
                log.debug(
                    "%s should be joined because %s real Matrix users are in room %s",
                    ircRoom.channel, roomInfoMap[roomId].realJoinedUsers.length, roomId
                );
                if (roomInfoMap[roomId].realJoinedUsers.length < 5) {
                    log.debug("These are: %s", JSON.stringify(roomInfoMap[roomId].realJoinedUsers));
                }
            });
        })
    });

    let channelsArray = Array.from(channels);
    log.debug(
        "getChannelsToJoin => %s should be synced: %s",
        channelsArray.length, JSON.stringify(channelsArray)
    );
    return channelsArray;
});

// map irc channel to a list of room IDs. If all of those
// room IDs have no real users in them, then part the bridge bot too.
MemberListSyncer.prototype.checkBotPartRoom = Promise.coroutine(function*(ircRoom, req) {
    if (ircRoom.channel.indexOf("#") !== 0) {
        return; // don't leave PM rooms
    }
    let matrixRooms = yield this.ircBridge.getStore().getMatrixRoomsForChannel(
        ircRoom.server, ircRoom.channel
    );

    if (matrixRooms.length === 0) {
        // no mapped rooms, leave the channel.
        this.ircBridge.partBot(ircRoom);
    }
    else if (matrixRooms.length === 1) {
        // common case, just hit /state rather than slow /initialSync
        let roomId = matrixRooms[0].getId();
        let res = yield this.appServiceBot.getClient().roomState(roomId);
        let data = getRoomMemberData(ircRoom.server, roomId, res, this.appServiceUserId);
        req.log.debug("%s Matrix users are in room %s", data.reals.length, roomId);
        if (data.reals.length === 0) {
            this.ircBridge.partBot(ircRoom);
        }
    }
    else {
        // hit initial sync to get list
        let syncableRooms = yield this._getSyncableRooms(ircRoom.server, true);
        matrixRooms.forEach(function(matrixRoom) {
            // if the room isn't in the syncable rooms list, then we part.
            var shouldPart = true;
            for (var i = 0; i < syncableRooms.length; i++) {
                if (syncableRooms[i].id === matrixRoom.getId()) {
                    shouldPart = false;
                    break;
                }
            }
            if (shouldPart) {
                this.ircBridge.partBot(ircRoom);
            }
        });
    }
});

// grab all rooms the bot knows about which have at least 1 real user in them.
// ignoreCache exists because this function hammers /initialSync and that is expeeeensive,
// so we don't do it unless they need absolutely fresh data. On startup, this can be called
// multiple times, so we cache the first request's promise and return that instead of making
// double hits.
MemberListSyncer.prototype._getSyncableRooms = function(server, ignoreCache) {
    if (!ignoreCache && this._syncableRoomsPromise) {
        log.debug("Returning existing _getSyncableRooms Promise");
        return this._syncableRoomsPromise;
    }

    // hit /initialSync on the bot to pull in room state for all rooms.
    let self = this;
    let fetchRooms = Promise.coroutine(function*() {
        let attempts = 0;
        while (attempts < 10) {
            try {
                // roomDict = { room_id: RoomInfo }
                let roomDict = yield self.appServiceBot.getMemberLists();
                return Object.keys(roomDict).map(function(roomId) {
                    return roomDict[roomId];
                }).filter(function(roomInfo) {
                    // filter out rooms with no real matrix users in them.
                    return roomInfo.realJoinedUsers.length > 0;
                });
            }
            catch (err) {
                log.error("Failed to fetch syncable rooms: " + err.stack);
                attempts += 1;
                yield Promise.delay(attempts * 5000); // wait 5s,10s,15s.. and try again
            }
        }
        log.error("Failed to fetch syncable rooms: Giving up.");
        return [];
    });

    this._syncableRoomsPromise = fetchRooms();
    return this._syncableRoomsPromise;
};

function joinMatrixUsersToChannels(rooms, server, injectJoinFn) {
    var d = promiseutil.defer();

    // filter out rooms listed in the rules
    var filteredRooms = [];
    rooms.forEach(function(roomInfo) {
        if (!server.shouldSyncMembershipToIrc("initial", roomInfo.id)) {
            log.debug(
                "Trimming room %s according to config rules (matrixToIrc=false)",
                roomInfo.id
            );
            if (!roomInfo.realJoinedUsers[0]) {
                return; // no joined users at all
            }
            // trim the list to a single user. We do this rather than filter the
            // room out entirely because otherwise there will be NO matrix users
            // on the IRC-side resulting in no traffic whatsoever.
            roomInfo.realJoinedUsers = [roomInfo.realJoinedUsers[0]];
            log.debug("Trimmed to " + roomInfo.realJoinedUsers);
        }
        filteredRooms.push(roomInfo);
    });

    log.debug("%s rooms passed the config rules", filteredRooms.length);

    // map the filtered rooms to a list of users to join
    // [Room:{reals:[uid,uid]}, ...] => [{uid,roomid}, ...]
    var entries = [];
    filteredRooms.forEach(function(roomInfo) {
        roomInfo.realJoinedUsers.forEach(function(uid, index) {
            entries.push({
                roomId: roomInfo.id,
                userId: uid,
                // Mark the first real matrix user f.e room so we can inject
                // them first to get back up and running more quickly when there
                // is no bot.
                frontier: (index === 0)
            });
        });
    });
    // sort frontier markers to the front of the array
    entries.sort(function(a, b) {
        if (a.frontier && !b.frontier) {
            return -1; // a comes first
        }
        else if (b.frontier && !a.frontier) {
            return 1; // b comes first
        }
        return 0; // don't care
    });

    log.debug("Got %s matrix join events to inject.", entries.length);
    // take the first entry and inject a join event
    function joinNextUser() {
        var entry = entries.shift();
        if (!entry) {
            d.resolve();
            return;
        }
        if (entry.userId.indexOf("@-") === 0) {
            joinNextUser();
            return;
        }
        log.debug(
            "Injecting join event for %s in %s (%s left) is_frontier=%s",
            entry.userId, entry.roomId, entries.length, entry.frontier
        );
        injectJoinFn(entry.roomId, entry.userId, entry.frontier).timeout(
            server.getMemberListFloodDelayMs()
        ).then(() => {
            joinNextUser();
        }, (err) => { // discard error, this will be due to timeouts which we don't want to log
            joinNextUser();
        });
    }

    joinNextUser();

    return d.promise;
}

function leaveIrcUsersFromRooms(rooms, server) {
    return Promise.resolve();
}

function getRoomMemberData(server, roomId, stateEvents, appServiceUserId) {
    stateEvents = stateEvents || [];
    var data = {
        roomId: roomId,
        virtuals: [],
        reals: []
    };
    stateEvents.forEach(function(event) {
        if (event.type !== "m.room.member" || event.content.membership !== "join") {
            return;
        }
        var userId = event.state_key;
        if (userId === appServiceUserId) {
            return;
        }
        if (server.claimsUserId(userId)) {
            data.virtuals.push(userId);
        }
        else if (userId.indexOf("@-") === 0) {
            // Ignore guest user IDs -- TODO: Do this properly by passing them through
        }
        else {
            data.reals.push(userId);
        }
    });
    return data;
}

module.exports = MemberListSyncer;
