/*eslint no-invalid-this: 0*/ // eslint doesn't understand Promise.coroutine wrapping

// Controls the logic for determining which membership lists should be synced and
// handles the sequence of events until the lists are in sync.
"use strict";

var Promise = require("bluebird");
var promiseutil = require("../promiseutil");
var log = require("../logging").get("MemberListSyncer");
var stats = require("../config/stats");
var QueuePool = require("../util/QueuePool");
var Queue = require("../util/Queue");

function MemberListSyncer(ircBridge, appServiceBot, server, appServiceUserId, injectJoinFn) {
    this.ircBridge = ircBridge;
    this.appServiceBot = appServiceBot;
    this.server = server;
    this.appServiceUserId = appServiceUserId;
    this.injectJoinFn = injectJoinFn;
    this._syncableRoomsPromise = null;
    this._memberLists = {
        matrix: {
            //$roomId : {
            //    id: roomId,
            //    state: stateEvents,
            //    realJoinedUsers: [],
            //    remoteJoinedUsers: []
            //  }
        },
        irc: {
            //$channel : nick[]
        }
    };

    // A queue which controls the rate at which leaves are sent to Matrix. We need this queue
    // because Synapse is slow. Synapse locks based on the room ID, so there is no benefit to
    // having 2 in-flight requests for the same room ID. As a result, we want to queue based
    // on the room ID, and let N "room queues" be processed concurrently. This can be
    // represented as a QueuePool of size N, which enqueues all the requests for a single
    // room in one go, which we can do because IRC sends all the nicks down as NAMES. For each
    // block of users in a room queue, we need another Queue to ensure that there is only ever
    // 1 in-flight leave request at a time per room queue.
    this._leaveQueuePool = new QueuePool(3, this._leaveUsersInRoom.bind(this));
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
    let rooms = yield this._getSyncableRooms();
    log.info("Found %s syncable rooms (%sms)", rooms.length, Date.now() - start);
    this.leaveIrcUsersFromRooms(rooms, server);
    start = Date.now();
    log.info("Joining Matrix users to IRC channels...");
    yield joinMatrixUsersToChannels(rooms, server, this.injectJoinFn);
    log.info("Joined Matrix users to IRC channels. (%sms)", Date.now() - start);
    // NB: We do not need to explicitly join IRC users to Matrix rooms
    // because we get all of the NAMEs/JOINs as events when we connect to
    // the IRC server. This effectively "injects" the list for us.
});

MemberListSyncer.prototype.getChannelsToJoin = Promise.coroutine(function*() {
    let server = this.server;
    log.debug("getChannelsToJoin => %s", server.domain);
    let rooms = yield this._getSyncableRooms();

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
        yield this.ircBridge.partBot(ircRoom);
        return;
    }

    // At least 1 mapped room - query for the membership list in each room. If there are
    // any real users still left in the room, then do not part the bot from the channel.
    // Query via /$room_id/state rather than /initialSync as the latter can cause
    // the bridge to spin for minutes if the response is large.

    let shouldPart = true;
    for (let i = 0; i < matrixRooms.length; i++) {
        let roomId = matrixRooms[i].getId();
        req.log.debug("checkBotPartRoom: Querying room state in room %s", roomId);
        let res = yield this.appServiceBot.getClient().roomState(roomId);
        let data = getRoomMemberData(ircRoom.server, roomId, res, this.appServiceUserId);
        req.log.debug(
            "checkBotPartRoom: %s Matrix users are in room %s", data.reals.length, roomId
        );
        if (data.reals.length > 0) {
            shouldPart = false;
            break;
        }
    }

    if (shouldPart) {
        yield this.ircBridge.partBot(ircRoom);
    }
});

// grab all rooms the bot knows about which have at least 1 real user in them.
// On startup, this can be called multiple times, so we cache the first request's promise
// and return that instead of making double hits.
//
// returns [
//   {
//       id: roomId,
//       realJoinedUsers: [],
//       remoteJoinedUsers: []
//   },
//   ...
// ]
MemberListSyncer.prototype._getSyncableRooms = function() {
    if (this._syncableRoomsPromise) {
        log.debug("Returning existing _getSyncableRooms Promise");
        return this._syncableRoomsPromise;
    }

    let self = this;
    let fetchRooms = Promise.coroutine(function*() {
        let roomInfoList = [];

        let roomIdToChannel = yield self.ircBridge.getStore().getAllChannelMappings();
        let joinedRoomIds = Object.keys(roomIdToChannel);

        // fetch joined members allowing 50 in-flight reqs at a time
        let pool = new QueuePool(50, Promise.coroutine(function*(roomId) {
            let userMap = null;
            while (!userMap) {
                try {
                    userMap = yield self.appServiceBot.getJoinedMembers(roomId);
                }
                catch (err) {
                    log.error(`Failed to getJoinedMembers in room ${roomId}: ${err}`);
                    yield Promise.delay(3000); // wait a bit before retrying
                }
            }
            let roomInfo = {
                id: roomId,
                displayNames: {}, // user ID => Display Name
                realJoinedUsers: [], // user IDs
                remoteJoinedUsers: [], // user IDs
            };
            let userIds = Object.keys(userMap);
            for (let j = 0; j < userIds.length; j++) {
                let userId = userIds[j];
                if (self.appServiceBot.getUserId() === userId) {
                    continue;
                }
                // TODO: Make this function public, it's useful!
                if (self.appServiceBot._isRemoteUser(userId)) {
                    roomInfo.remoteJoinedUsers.push(userId);
                }
                else {
                    roomInfo.realJoinedUsers.push(userId);
                }

                if (userMap[userId].display_name) {
                    roomInfo.displayNames[userId] = userMap[userId].display_name;
                }
            }
            roomInfoList.push(roomInfo);
            log.info(
                "%s has %s real Matrix users and %s remote users (%s/%s)",
                roomId, roomInfo.realJoinedUsers.length, roomInfo.remoteJoinedUsers.length,
                roomInfoList.length, joinedRoomIds.length
            );
        }));
        // wait for all the requests to go through
        yield Promise.all(joinedRoomIds.map((roomId) => {
            return pool.enqueue(roomId, roomId);
        }));

        return roomInfoList.filter(function(roomInfo) {
            // filter out rooms with no real matrix users in them.
            return roomInfo.realJoinedUsers.length > 0;
        });
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
                displayName: roomInfo.displayNames[uid],
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
        injectJoinFn(entry.roomId, entry.userId, entry.displayName, entry.frontier).timeout(
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

MemberListSyncer.prototype.leaveIrcUsersFromRooms = function(rooms, server) {
    log.info(
        `leaveIrcUsersFromRooms: storing member list info for ${rooms.length} ` +
        `rooms for server ${server.domain}`
    );

    // Store the matrix room info in memory for later retrieval when NAMES is received
    // and updateIrcMemberList is called. At that point, we have enough information to
    // leave users from the channel that the NAMES is for.
    rooms.forEach((roomInfo) => {
        this._memberLists.matrix[roomInfo.id] = roomInfo;
    });
}

// Critical section of the leave queue pool.
// item looks like:
// {
//   roomId: "!foo:bar", userIds: [ "@alice:bar", "@bob:bar", ... ]
// }
MemberListSyncer.prototype._leaveUsersInRoom = Promise.coroutine(function*(item) {
    // We need to queue these up in ANOTHER queue so as not to have
    // 2 in-flight requests at the same time. We return a promise which resolves
    // when this room is completely done.
    let self = this;
    let q = new Queue(Promise.coroutine(function*(userId) {
        yield self.ircBridge.getAppServiceBridge().getIntent(userId).leave(item.roomId);
        stats.membership(true, "part");
    }));
    yield Promise.all(item.userIds.map((userId) => {
        return q.enqueue(userId, userId);
    }));
});

// Update the MemberListSyncer with the IRC NAMES_RPL that has been received for channel.
// This will leave any matrix users that do not have their associated IRC nick in the list
// of names for this channel.
MemberListSyncer.prototype.updateIrcMemberList = Promise.coroutine(function*(channel, names) {
    if (this._memberLists.irc[channel] !== undefined ||
            !this.server.shouldSyncMembershipToMatrix("initial", channel)) {
        return;
    }
    this._memberLists.irc[channel] = Object.keys(names);

    log.info(
        `updateIrcMemberList: Updating IRC member list for ${channel} with ` +
        `${this._memberLists.irc[channel].length} IRC nicks`
    );

    // Convert the IRC channels nicks to userIds
    let ircUserIds = this._memberLists.irc[channel].map(
        (nick) => this.server.getUserIdFromNick(nick)
    );

    // For all bridged rooms, leave users from matrix that are not in the channel
    let roomsForChannel = yield this.ircBridge.getStore().getMatrixRoomsForChannel(
        this.server, channel
    );

    if (roomsForChannel.length === 0) {
        log.info(`updateIrcMemberList: No bridged rooms for channel ${channel}`);
        return;
    }

    // If a userId is in remoteJoinedUsers, but not ircUserIds, intend on leaving roomId
    let promises = [];
    roomsForChannel.forEach((matrixRoom) => {
        let roomId = matrixRoom.getId();
        if (!(
                this._memberLists.matrix[roomId] &&
                this._memberLists.matrix[roomId].remoteJoinedUsers
            )) {
                return;
        }
        let usersToLeave = this._memberLists.matrix[roomId].remoteJoinedUsers.filter(
            (userId) => {
                return ircUserIds.indexOf(userId) === -1;
            }
        );
        // ID is the complete mapping of roomID/channel which will be unique
        promises.push(this._leaveQueuePool.enqueue(roomId + " " + channel, {
            roomId: roomId,
            userIds: usersToLeave,
        }));
    });
    log.info(
        `updateIrcMemberList: Leaving ${promises.length} users as they are not in ${channel}.`
    );
    yield Promise.all(promises);
});

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
