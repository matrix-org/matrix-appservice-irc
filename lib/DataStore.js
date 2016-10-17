/*eslint no-invalid-this: 0*/ // eslint doesn't understand Promise.coroutine wrapping
"use strict";

var Promise = require("bluebird");

var MatrixRoom = require("matrix-appservice-bridge").MatrixRoom;
var MatrixUser = require("matrix-appservice-bridge").MatrixUser;
var RemoteUser = require("matrix-appservice-bridge").RemoteUser;
var IrcRoom = require("./models/IrcRoom");
var IrcClientConfig = require("./models/IrcClientConfig");
var log = require("./logging").get("DataStore");

function DataStore(userStore, roomStore) {
    this._roomStore = roomStore;
    this._userStore = userStore;
    this._serverMappings = {}; // { domain: IrcServer }

    var errLog = function(fieldName) {
        return function(err) {
            if (err) {
                log.error("Failed to ensure '%s' index on store: " + err, fieldName);
                return;
            }
            log.info("Indexes checked on '%s' for store.", fieldName);
        };
    };

    // add some indexes
    this._roomStore.db.ensureIndex({
        fieldName: "id",
        unique: true,
        sparse: false
    }, errLog("id"));
    this._roomStore.db.ensureIndex({
        fieldName: "matrix_id",
        unique: false,
        sparse: true
    }, errLog("matrix_id"));
    this._roomStore.db.ensureIndex({
        fieldName: "remote_id",
        unique: false,
        sparse: true
    }, errLog("remote_id"));
    this._userStore.db.ensureIndex({
        fieldName: "data.localpart",
        unique: false,
        sparse: true
    }, errLog("localpart"));
    this._userStore.db.ensureIndex({
        fieldName: "id",
        unique: true,
        sparse: false
    }, errLog("user id"));
}

DataStore.prototype.setServerFromConfig = Promise.coroutine(function*(server, serverConfig) {
    log.debug("setServerFromConfig");
    this._serverMappings[server.domain] = server;

    var channels = Object.keys(serverConfig.mappings);
    for (var i = 0; i < channels.length; i++) {
        var channel = channels[i];
        for (var k = 0; k < serverConfig.mappings[channel].length; k++) {
            var ircRoom = new IrcRoom(server, channel);
            var mxRoom = new MatrixRoom(
                serverConfig.mappings[channel][k]
            );
            yield this.storeRoom(ircRoom, mxRoom, 'config');
        }
    }
});

/**
 * Persists an IRC <--> Matrix room mapping in the database.
 * @param {IrcRoom} ircRoom : The IRC room to store.
 * @param {MatrixRoom} matrixRoom : The Matrix room to store.
 * @param {string} origin : "config" if this mapping is from the config yaml,
 * "provision" if this mapping was provisioned, "alias" if it was created via
 * aliasing and "join" if it was created during a join.
 * @return {Promise}
 */
DataStore.prototype.storeRoom = function(ircRoom, matrixRoom, origin) {
    if (typeof origin !== 'string') {
        throw new Error('Origin must be a string = "config"|"provision"|"alias"|"join"');
    }

    log.info("storeRoom (id=%s, addr=%s, chan=%s, origin=%s)",
        matrixRoom.getId(), ircRoom.get("domain"), ircRoom.channel, origin);

    let mappingId = createMappingId(matrixRoom.getId(), ircRoom.get("domain"), ircRoom.channel);
    return this._roomStore.linkRooms(matrixRoom, ircRoom, {
        origin: origin
    }, mappingId);
};

/**
 * Get an IRC <--> Matrix room mapping from the database.
 * @param {string} roomId : The Matrix room ID.
 * @param {string} ircDomain : The IRC server domain.
 * @param {string} ircChannel : The IRC channel.
 * @param {string} origin : (Optional) "config" if this mapping was from the config yaml,
 * "provision" if this mapping was provisioned, "alias" if it was created via aliasing and
 * "join" if it was created during a join.
 * @return {Promise} A promise which resolves to a room entry, or null if one is not found.
 */
DataStore.prototype.getRoom = function(roomId, ircDomain, ircChannel, origin) {
    if (typeof origin !== 'undefined' && typeof origin !== 'string') {
        throw new Error(`If defined, origin must be a string =
            "config"|"provision"|"alias"|"join"`);
    }
    let mappingId = createMappingId(roomId, ircDomain, ircChannel);

    return this._roomStore.getEntryById(mappingId).then(
        (entry) => {
            if (origin && entry && origin !== entry.data.origin) {
                return null;
            }
            return entry;
        });
};

/**
 * Get all Matrix <--> IRC room mappings from the database.
 * @return {Promise} A promise which resolves to a map:
 *      $roomId => ['server #channel1', 'server #channel2',...]
 */
DataStore.prototype.getAllChannelMappings = Promise.coroutine(function*() {
    let entries = yield this._roomStore.select(
        {
            matrix_id: {$exists: true},
            remote_id: {$exists: true},
            'remote.type': "channel"
        }
    );

    let roomIds = new Set(entries.map((e) => e.matrix_id));

    let mappings = {};

    roomIds.forEach((roomId) => {
        mappings[roomId] = entries.filter(
            (e) => e.matrix_id === roomId
        ).map((e) => {
            return {
                domain: e.remote.domain,
                channel: e.remote.channel
            }
        });
    });

    return mappings;
});

/**
 * Get provisioned IRC <--> Matrix room mappings from the database where
 * the matrix room ID is roomId.
 * @param {string} roomId : The Matrix room ID.
 * @return {Promise} A promise which resolves to a list
 * of entries.
 */
DataStore.prototype.getProvisionedMappings = function(roomId) {
    log.info(`getProvisionedMappings('${roomId}')`);
    return this._roomStore.getEntriesByMatrixId(roomId).filter(
        (entry) => {
            return entry.data && entry.data.origin === 'provision'
        });
};

/**
 * Remove an IRC <--> Matrix room mapping from the database.
 * @param {string} roomId : The Matrix room ID.
 * @param {string} ircDomain : The IRC server domain.
 * @param {string} ircChannel : The IRC channel.
 * @param {string} origin : "config" if this mapping was from the config yaml,
 * "provision" if this mapping was provisioned, "alias" if it was created via
 * aliasing and "join" if it was created during a join.
 * @return {Promise}
 */
DataStore.prototype.removeRoom = function(roomId, ircDomain, ircChannel, origin) {
    if (typeof origin !== 'string') {
        throw new Error('Origin must be a string = "config"|"provision"|"alias"|"join"');
    }

    log.info("removeRoom (id=%s, addr=%s, chan=%s, origin=%s)",
        roomId, ircDomain, ircChannel, origin);
    return this._roomStore.delete({
        id: createMappingId(roomId, ircDomain, ircChannel),
        'data.origin': origin
    });
};

/**
 * Retrieve a list of IRC rooms for a given room ID.
 * @param {string} roomId : The room ID to get mapped IRC channels.
 * @return {Promise<Array<IrcRoom>>} A promise which resolves to a list of
 * rooms.
 */
DataStore.prototype.getIrcChannelsForRoomId = function(roomId) {
    log.debug("getIrcChannelsForRoomId " + roomId);
    return this._roomStore.getLinkedRemoteRooms(roomId).then((remoteRooms) => {
        return remoteRooms.filter((remoteRoom) => {
            return Boolean(this._serverMappings[remoteRoom.get("domain")]);
        }).map((remoteRoom) => {
            let server = this._serverMappings[remoteRoom.get("domain")];
            return IrcRoom.fromRemoteRoom(server, remoteRoom);
        });
    });
};

/**
 * Retrieve a list of IRC rooms for a given list of room IDs. This is significantly
 * faster than calling getIrcChannelsForRoomId for each room ID.
 * @param {string[]} roomIds : The room IDs to get mapped IRC channels.
 * @return {Promise<Map<string, IrcRoom[]>>} A promise which resolves to a map of
 * room ID to an array of IRC rooms.
 */
DataStore.prototype.getIrcChannelsForRoomIds = function(roomIds) {
    log.debug("getIrcChannelsForRoomIds " + JSON.stringify(roomIds));
    return this._roomStore.batchGetLinkedRemoteRooms(roomIds).then((roomIdToRemoteRooms) => {
        Object.keys(roomIdToRemoteRooms).forEach((roomId) => {
            // filter out rooms with unknown IRC servers and
            // map RemoteRooms to IrcRooms
            roomIdToRemoteRooms[roomId] = roomIdToRemoteRooms[roomId].filter((remoteRoom) => {
                return Boolean(this._serverMappings[remoteRoom.get("domain")]);
            }).map((remoteRoom) => {
                let server = this._serverMappings[remoteRoom.get("domain")];
                return IrcRoom.fromRemoteRoom(server, remoteRoom);
            });
        });
        return roomIdToRemoteRooms;
    });
};

/**
 * Retrieve a list of Matrix rooms for a given server and channel.
 * @param {IrcServer} server : The server to get rooms for.
 * @param {string} channel : The channel to get mapped rooms for.
 * @return {Promise<Array<MatrixRoom>>} A promise which resolves to a list of rooms.
 */
DataStore.prototype.getMatrixRoomsForChannel = function(server, channel) {
    log.debug("getMatrixRoomsForChannel " + channel);
    var ircRoom = new IrcRoom(server, channel);
    return this._roomStore.getLinkedMatrixRooms(
        IrcRoom.createId(ircRoom.getServer(), ircRoom.getChannel())
    );
};

DataStore.prototype.setPmRoom = function(ircRoom, matrixRoom, userId, virtualUserId) {
    log.info("setPmRoom (id=%s, addr=%s chan=%s real=%s virt=%s)",
        matrixRoom.getId(), ircRoom.server.domain, ircRoom.channel, userId,
        virtualUserId);

    return this._roomStore.linkRooms(matrixRoom, ircRoom, {
        real_user_id: userId,
        virtual_user_id: virtualUserId
    }, createPmId(userId, virtualUserId));
};

DataStore.prototype.getMatrixPmRoom = function(realUserId, virtualUserId) {
    log.debug("getMatrixPmRoom " + realUserId);
    var id = createPmId(realUserId, virtualUserId);
    return this._roomStore.getEntryById(id).then(function(entry) {
        if (!entry) {
            return null;
        }
        return entry.matrix;
    });
};

DataStore.prototype.getTrackedChannelsForServer = function(ircAddr) {
    log.debug("getTrackedChannelsForServer " + ircAddr);
    return this._roomStore.getEntriesByRemoteRoomData({ domain: ircAddr }).then(
    (entries) => {
        var channels = [];
        entries.forEach((e) => {
            let r = e.remote;
            let server = this._serverMappings[r.get("domain")];
            if (!server) {
                return;
            }
            let ircRoom = IrcRoom.fromRemoteRoom(server, r);
            if (ircRoom.getType() === "channel") {
                channels.push(ircRoom.getChannel());
            }
        });
        return channels;
    });
};

DataStore.prototype.getRoomIdsFromConfig = function() {
    log.debug("getRoomIdsFromConfig ");
    return this._roomStore.getEntriesByLinkData({
        origin: 'config'
    }).then(function(entries) {
        return entries.map((e) => {
            return e.matrix.getId();
        });
    });
};

DataStore.prototype.removeConfigMappings = function() {
    log.debug("removeConfigMappings ");
    return this._roomStore.removeEntriesByLinkData({
        from_config: true // for backwards compatibility
    }).then(() => {
        return this._roomStore.removeEntriesByLinkData({
            origin: 'config'
        })
    });
};

DataStore.prototype.getIpv6Counter = Promise.coroutine(function*() {
    log.debug("getIpv6Counter ");
    let config = yield this._userStore.getRemoteUser("config");
    if (!config) {
        config = new RemoteUser("config");
        config.set("ipv6_counter", 0);
        yield this._userStore.setRemoteUser(config);
    }
    return config.get("ipv6_counter");
});

DataStore.prototype.setIpv6Counter = Promise.coroutine(function*(counter) {
    log.debug("setIpv6Counter ");
    let config = yield this._userStore.getRemoteUser("config");
    if (!config) {
        config = new RemoteUser("config");
    }
    config.set("ipv6_counter", counter);
    yield this._userStore.setRemoteUser(config);
});

/**
 * Retrieve a stored admin room based on the room's ID.
 * @param {String} roomId : The room ID of the admin room.
 * @return {Promise} Resolved when the room is retrieved.
 */
DataStore.prototype.getAdminRoomById = function(roomId) {
    log.debug("getAdminRoomById " + roomId);
    return this._roomStore.getEntriesByMatrixId(roomId).then(function(entries) {
        if (entries.length == 0) {
            return null;
        }
        if (entries.length > 1) {
            log.error("getAdminRoomById(" + roomId + ") has " + entries.length + " entries");
        }
        if (entries[0].matrix.get("admin_id")) {
            return entries[0].matrix;
        }
        return null;
    });
};

/**
 * Stores a unique admin room for a given user ID.
 * @param {MatrixRoom} room : The matrix room which is the admin room for this user.
 * @param {String} userId : The user ID who is getting an admin room.
 * @return {Promise} Resolved when the room is stored.
 */
DataStore.prototype.storeAdminRoom = function(room, userId) {
    log.info("storeAdminRoom (id=%s, user_id=%s)", room.getId(), userId);
    room.set("admin_id", userId);
    return this._roomStore.upsertEntry({
        id: createAdminId(userId),
        matrix: room,
    });
};

DataStore.prototype.getAdminRoomByUserId = function(userId) {
    log.debug("getAdminRoomByUserId " + userId);
    return this._roomStore.getEntryById(createAdminId(userId)).then(function(entry) {
        if (!entry) {
            return null;
        }
        return entry.matrix;
    });
};

DataStore.prototype.storeMatrixUser = function(matrixUser) {
    log.debug("storeMatrixUser " + JSON.stringify(matrixUser));
    return this._userStore.setMatrixUser(matrixUser);
};

DataStore.prototype.getMatrixUserByLocalpart = function(localpart) {
    log.debug("getMatrixUserByLocalpart " + localpart);
    return this._userStore.getByMatrixLocalpart(localpart);
};

DataStore.prototype.getIrcClientConfig = function(userId, domain) {
    log.debug("getIrcClientConfig " + userId);
    return this._userStore.getMatrixUser(userId).then((matrixUser) => {
        if (!matrixUser) {
            return null;
        }
        var userConfig = matrixUser.get("client_config");
        if (!userConfig) {
            return null;
        }
        // map back from _ to .
        Object.keys(userConfig).forEach(function(domainWithUnderscores) {
            let actualDomain = domainWithUnderscores.replace(/_/g, ".");
            if (actualDomain !== domainWithUnderscores) { // false for 'localhost'
                userConfig[actualDomain] = userConfig[domainWithUnderscores];
                delete userConfig[domainWithUnderscores];
            }
        })
        var configData = userConfig[domain];
        if (!configData) {
            return null;
        }
        return new IrcClientConfig(userId, domain, configData);
    });
};

DataStore.prototype.storeIrcClientConfig = function(config) {
    log.info("storeIrcClientConfig " + config);
    return this._userStore.getMatrixUser(config.getUserId()).then((user) => {
        if (!user) {
            user = new MatrixUser(config.getUserId());
        }
        var userConfig = user.get("client_config") || {};
        userConfig[config.getDomain().replace(/\./g, "_")] = config.serialize();
        user.set("client_config", userConfig);
        return this._userStore.setMatrixUser(user);
    });
};

DataStore.prototype.getMatrixUserByUsername = Promise.coroutine(
function*(domain, username) {
    log.info("getMatrixUserByUsername " + username);
    let domainKey = domain.replace(/\./g, "_");
    let matrixUsers = yield this._userStore.getByMatrixData({
        ["client_config." + domainKey + ".username"]: username
    });

    if (matrixUsers.length > 1) {
        log.error(
            "getMatrixUserByUsername return %s results for %s on %s",
            matrixUsers.length, username, domain
        );
    }
    return matrixUsers[0];
});

function createPmId(userId, virtualUserId) {
    // space as delimiter as none of these IDs allow spaces.
    return "PM_" + userId + " " + virtualUserId; // clobber based on this.
}

function createAdminId(userId) {
    return "ADMIN_" + userId; // clobber based on this.
}

function createMappingId(roomId, ircDomain, ircChannel) {
    // space as delimiter as none of these IDs allow spaces.
    return roomId + " " + ircDomain + " " + ircChannel; // clobber based on this
}

module.exports = DataStore;
