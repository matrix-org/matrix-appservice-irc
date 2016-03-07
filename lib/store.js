/*
 * Provides storage for dynamically created IRC channel/room ID mappings, in
 * addition to other things like the home server token.
 */
"use strict";

var Promise = require("bluebird");
var promiseutil = require("./promiseutil");

var rooms = require("./models/rooms");
var IrcRoom = rooms.IrcRoom;
var MatrixRoom = rooms.MatrixRoom;
var MatrixUser = require("matrix-appservice-bridge").MatrixUser;
var IrcUser = require("./models/IrcUser");
var log = require("./logging").get("database");
var toIrcLowerCase = require("./irclib/formatting").toIrcLowerCase;

var Datastore = require("nedb");

var collection = {
    rooms: { db: null, loc: "/rooms.db", defer: promiseutil.defer() },
    config: { db: null, loc: "/config.db", defer: promiseutil.defer() },
    users: { db: null, loc: "/users.db", defer: promiseutil.defer() },
    irc_clients: { db: null, loc: "/irc_clients.db", defer: promiseutil.defer() }
};

/**
 * @type {Promise}
 */
var dbPromise = null;

var serverMappings = {
    // domain : IrcServer
};

var getCollection = function(name) {
    return collection[name].db;
};

// wrapper to use promises
var callbackFn = function(d, err, result) {
    if (err) {
        d.reject(err);
    }
    else {
        d.resolve(result);
    }
};

var insert = function(db, d, objects) {
    db.insert(objects, function(err, result) {
        callbackFn(d, err, result);
    });
};
var upsert = function(db, d, query, updateVals) {
    db.update(query, updateVals, {upsert: true}, function(err, result) {
        callbackFn(d, err, result);
    });
};
var update = function(db, d, query, updateVals) {
    db.update(query, updateVals, {upsert: false}, function(err, result) {
        callbackFn(d, err, result);
    });
};
var del = function(db, d, query) {
    db.remove(query, {multi: true}, function(err, result) {
        log.info("Removed %s entries", JSON.stringify(result));
        callbackFn(d, err, result);
    });
};

/**
 * @param {!Object} col : The database collection to search.
 * @param {Deferred} d : The deferred to resolve/reject on completion.
 * @param {!Object} query : The query to execute.
 * @param {boolean} multiple : True to return multiple entries.
 * @param {Function=} transformFn : Optional. The function to invoke to transform
 * each result.
 */
var select = function(col, d, query, multiple, transformFn) {
    if (multiple) {
        col.find(query, function(err, docs) {
            callbackFn(d, err, transformFn ? transformFn(docs) : docs);
        });
    }
    else {
        col.findOne(query, function(err, docs) {
            callbackFn(d, err, transformFn ? transformFn(docs) : docs);
        });
    }
};

/**
 * Connect to the NEDB database.
 * @param {string} databaseUri : The URI which contains the path to the db directory.
 * @return {Promise} Resolved when connected to the database.
 */
module.exports.connectToDatabase = function(databaseUri) {
    log.info("connectToDatabase -> %s", databaseUri);
    if (dbPromise) {
        return dbPromise;
    }

    if (databaseUri.indexOf("nedb://") !== 0) {
        return Promise.reject(
            "Must use a nedb:// URI of the form nedb://databasefolder"
        );
    }
    var baseDbName = databaseUri.substring("nedb://".length);

    var promises = [];
    Object.keys(collection).forEach(function(dbKey) {
        promises.push(collection[dbKey].defer.promise);

        collection[dbKey].db = new Datastore({
            filename: baseDbName + collection[dbKey].loc,
            autoload: true,
            onload: function(err) {
                if (err) {
                    collection[dbKey].defer.reject(err);
                }
                else {
                    collection[dbKey].defer.resolve();
                }
            }
        });
    });

    dbPromise = Promise.all(promises);

    return dbPromise;
};

/**
 * Wait for a connection to the database. You must have called
 * {@link connectToDatabase} at least once.
 * @return {Promise} Resolved when connected to the database.
 */
module.exports.waitForDatabase = function() {
    return dbPromise;
};

/*
 * Creates the mappings specified in the config and remembers the server to
 * return.
 */
module.exports.setServerFromConfig = Promise.coroutine(function*(server, serverConfig) {
    serverMappings[server.domain] = server;

    var channels = Object.keys(serverConfig.mappings);
    for (var i = 0; i < channels.length; i++) {
        var channel = channels[i];
        for (var k = 0; k < serverConfig.mappings[channel].length; k++) {
            var ircRoom = new IrcRoom(server, channel);
            var mxRoom = new MatrixRoom(
                serverConfig.mappings[channel][k]
            );
            yield module.exports.rooms.set(ircRoom, mxRoom, true);
        }
    }
});

module.exports.config = {
    set: function(info) {
        var d = promiseutil.defer();
        upsert(getCollection("config"), d, {},
            {
                $set: info
            }
        );
        return d.promise;
    },

    get: function() {
        var d = promiseutil.defer();
        select(getCollection("config"), d, {}, false);
        return d.promise;
    }
};

module.exports.rooms = {
    /**
     * Persists an IRC <--> Matrix room mapping in the database.
     * @param {IrcRoom} ircRoom : The IRC room to store.
     * @param {MatrixRoom} matrixRoom : The Matrix room to store.
     * @param {boolean} fromConfig : True if this mapping is from the config yaml.
     * @return {Promise}
     */
    set: function(ircRoom, matrixRoom, fromConfig) {
        var d = promiseutil.defer();
        var addr = ircRoom.server ? ircRoom.server.domain : undefined;
        fromConfig = Boolean(fromConfig);

        log.info("rooms.set (id=%s, addr=%s, chan=%s, config=%s)",
            matrixRoom.roomId, addr, ircRoom.channel, fromConfig);

        insert(getCollection("rooms"), d, {
            room_id: matrixRoom.roomId,
            irc_addr: addr,
            irc_chan: toIrcLowerCase(ircRoom.channel),
            from_config: fromConfig,
            type: "channel"
        });
        return d.promise;
    },

    /**
     * Retrieve a list of IRC rooms for a given room ID.
     * @param {string} roomId : The room ID to get mapped IRC channels.
     * @return {Promise<Array<IrcRoom>>} A promise which resolves to a list of
     * rooms.
     */
    getIrcChannelsForRoomId: function(roomId) {
        var d = promiseutil.defer();
        select(getCollection("rooms"), d, {
            room_id: roomId
        }, true, function(docs) {
            var ircRooms = [];
            for (var i = 0; i < docs.length; i++) {
                var doc = docs[i];
                var server = doc.irc_addr ? serverMappings[doc.irc_addr] : null;
                var room = new IrcRoom(server, doc.irc_chan);
                if (server) {
                    ircRooms.push(room);
                }
            }
            return ircRooms;
        });
        return d.promise;
    },

    /**
     * Retrieve a list of Matrix rooms for a given server and channel.
     * @param {IrcServer} server : The server to get rooms for.
     * @param {string} channel : The channel to get mapped rooms for.
     * @return {Promise<Array<MatrixRoom>>} A promise which resolves to a list of rooms.
     */
    getMatrixRoomsForChannel: function(server, channel) {
        var d = promiseutil.defer();
        channel = toIrcLowerCase(channel); // all stored in lower case
        select(getCollection("rooms"), d, {
            irc_addr: server.domain,
            irc_chan: channel
        }, true, function(docs) {
            var mxRooms = [];
            for (var i = 0; i < docs.length; i++) {
                var doc = docs[i];
                var room = new MatrixRoom(doc.room_id);
                mxRooms.push(room);
            }
            return mxRooms;
        });
        return d.promise;
    },

    // NB: We need this to be different to storeRoom because for IRC you send the
    // PM to two separate 'rooms' ('to' room is the nick), and because we want to
    // clobber uid:uid pairs.
    setPmRoom: function(ircRoom, matrixRoom, userId, virtualUserId) {
        var d = promiseutil.defer();
        var addr = (
            ircRoom.server ? ircRoom.server.domain : undefined
        );

        log.info("setPmRoom (id=%s, addr=%s chan=%s real=%s virt=%s)",
            matrixRoom.roomId, addr, ircRoom.channel, userId,
            virtualUserId);

        upsert(getCollection("rooms"), d, {
            real_user_id: userId,
            virtual_user_id: virtualUserId
        },
        {
            $set: {
                room_id: matrixRoom.roomId,
                irc_addr: addr,
                irc_chan: toIrcLowerCase(ircRoom.channel),
                type: "pm",
                real_user_id: userId,
                virtual_user_id: virtualUserId
            }
        });
        return d.promise;
    },

    getMatrixPmRoom: function(realUserId, virtualUserId) {
        var d = promiseutil.defer();
        select(getCollection("rooms"), d, {
            type: "pm",
            real_user_id: realUserId,
            virtual_user_id: virtualUserId
        }, false, function(doc) {
            if (!doc) {
                return null;
            }
            return new MatrixRoom(doc.room_id);
        });
        return d.promise;
    },

    getTrackedChannelsForServer: function(ircAddr) {
        var d = promiseutil.defer();
        select(getCollection("rooms"), d, {
            irc_addr: ircAddr
        }, true, function(docs) {
            var channels = [];
            for (var i = 0; i < docs.length; i++) {
                if (docs[i].irc_chan && docs[i].irc_chan.indexOf("#") === 0) {
                    channels.push(docs[i].irc_chan);
                }
            }
            return channels;
        });
        return d.promise;
    },

    getRoomIdsFromConfig: function() {
        var d = promiseutil.defer();
        select(getCollection("rooms"), d, { from_config: true }, true,
        function(docs) {
            var roomIds = [];
            for (var i = 0; i < docs.length; i++) {
                if (docs[i].room_id) {
                    roomIds.push(docs[i].room_id);
                }
            }
            return roomIds;
        });
        return d.promise;
    },

    // removes all mappings with from_config = true
    removeConfigMappings: function() {
        var d = promiseutil.defer();
        log.info("removeConfigMappings");
        del(getCollection("rooms"), d, { from_config: true });
        return d.promise;
    },

    /**
     * Retrieve a stored admin room based on the room's ID.
     * @param {String} roomId : The room ID of the admin room.
     * @return {Promise} Resolved when the room is retrieved.
     */
    getAdminRoomById: function(roomId) {
        var d = promiseutil.defer();
        select(getCollection("rooms"), d, {
            type: "admin",
            room_id: roomId
        }, false, function(doc) {
            if (!doc) {
                return null;
            }
            return new MatrixRoom(doc.room_id);
        });
        return d.promise;
    },

    /**
     * Stores a unique admin room for a given user ID.
     * @param {MatrixRoom} room : The matrix room which is the admin room for this user.
     * @param {String} userId : The user ID who is getting an admin room.
     * @return {Promise} Resolved when the room is stored.
     */
    storeAdminRoom: function(room, userId) {
        var d = promiseutil.defer();
        log.info("storeAdminRoom (id=%s, user_id=%s)", room.roomId, userId);

        upsert(getCollection("rooms"), d, {
            user_id: userId,
            type: "admin"
        },
        {
            $set: {
                room_id: room.roomId,
                type: "admin",
                user_id: userId
            }
        });
        return d.promise;
    }
};

module.exports.users = {
    get: function(userLocalpart) {
        var d = promiseutil.defer();
        select(getCollection("users"), d, {
            localpart: userLocalpart
        }, false, function(doc) {
            if (!doc) {
                return null;
            }
            var u = new MatrixUser(doc.user_id);
            u.setDisplayName(doc.display_name);
        });
        return d.promise;
    },

    set: function(user, localpart, displayName, setDisplayName) {
        var d = promiseutil.defer();
        log.info(
            "storeUser (user_id=%s, localpart=%s display_name=%s " +
            "set_display_name=%s)",
            user.getId(), localpart, displayName, setDisplayName
        );

        upsert(getCollection("users"), d, {
            user_id: user.getId()
        },
        {
            $set: {
                user_id: user.getId(),
                localpart: localpart,
                display_name: displayName,
                set_display_name: setDisplayName
            }
        });
        return d.promise;
    }
};

module.exports.ircClients = {
    get: function(userId, domain) {
        var d = promiseutil.defer();
        select(getCollection("irc_clients"), d, {
            user_id: userId,
            domain: domain
        }, false, function(doc) {
            if (!doc) {
                return null;
            }
            var server = serverMappings[doc.domain];
            if (!server) {
                return null;
            }
            return new IrcUser(server, doc.nick, true, doc.password, doc.username);
        });
        return d.promise;
    },
    set: function(userId, ircUser) {
        var d = promiseutil.defer();
        log.info("Storing " + ircUser + " on behalf of " + userId);

        upsert(getCollection("irc_clients"), d, {
            user_id: userId,
            domain: ircUser.server.domain
        },
        {
            $set: {
                domain: ircUser.server.domain,
                nick: ircUser.nick,
                password: ircUser.password,
                username: ircUser.username,
                user_id: userId
            }
        });
        return d.promise;
    },
    update: function(userId, domain, key, newVal) {
        var d = promiseutil.defer();
        log.info(
            "Update %s for %s on %s to %s",
            key, userId, domain, newVal
        );
        var setVals = {};
        setVals[key] = newVal;

        update(getCollection("irc_clients"), d, {
            user_id: userId,
            domain: domain
        },
        {
            $set: setVals
        });
        return d.promise;
    },
    getByUsername: function(domain, username) {
        var d = promiseutil.defer();
        select(getCollection("irc_clients"), d, {
            domain: domain,
            username: username
        }, false, function(doc) {
            if (!doc) {
                return null;
            }
            var server = serverMappings[doc.domain];
            if (!server) {
                return null;
            }
            var usr = new IrcUser(server, doc.nick, true, doc.password, doc.username);
            usr.userId = doc.user_id; // FIXME: bodge
            return usr;
        });
        return d.promise;
    }
};
