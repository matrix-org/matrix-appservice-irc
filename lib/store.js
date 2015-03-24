/*
 * Provides storage for dynamically created IRC channel/room ID mappings, in
 * addition to other things like the home server token.
 */
"use-strict";
var q = require("q");
var Room = require("./models").Room;
var MongoClient = require('mongodb').MongoClient;
var log = require("./logging").get("database");

var db = null;
var dbDefer = null;
var serverMappings = {
    // domain : IrcServer
};

module.exports.connectToDatabase = function(databaseUri) {
    log.info("connectToDatabase -> %s", databaseUri);
    if (db) {
        return q(db);
    }
    if (dbDefer) {
        return dbDefer.promise;
    }
    dbDefer = q.defer();
    MongoClient.connect(databaseUri, {
        server: {
            auto_reconnect: true,
            poolSize: 4,
            socketOptions: {
                connectTimeoutMS: 3000
            }
        }
    }, function(err, dbInst) {
        if (err) {
            dbDefer.reject(err);
        } else {
            db = dbInst;
            dbDefer.resolve(db);
        }
    });
    return dbDefer.promise;
};
module.exports.waitForDatabase = function() {
    return dbDefer.promise;
};

module.exports.setRegistrationInfo = function(registrationInfo) {
    var d = q.defer();
    upsert(db.collection("config"), d, {}, 
        {
            $set: registrationInfo
        }
    )
    return d.promise;
};

module.exports.getRegistrationInfo = function() {
    var d = q.defer();
    select(db.collection("config"), d, {}, false);
    return d.promise;
};

module.exports.storeRoom = function(room, fromConfig) {
    var d = q.defer();
    var addr = room.server ? room.server.domain : undefined;
    fromConfig = Boolean(fromConfig);

    log.info("storeRoom (id=%s, addr=%s, chan=%s, config=%s)", 
        room.roomId, addr, room.channel, fromConfig);

    insert(db.collection("rooms"), d, {
        room_id: room.roomId,
        irc_addr: addr,
        irc_chan: room.channel,
        from_config: fromConfig
    });
    return d.promise;
};

module.exports.getRoomsForRoomId = function(roomId) {
    var d = q.defer();
    select(db.collection("rooms"), d, {
        room_id: roomId
    }, true, function(docs) {
        var rooms = [];
        for (var i=0; i<docs.length; i++) {
            var doc = docs[i];
            var room = new Room();
            if (doc.irc_addr) {
                // re-assign the server mapping
                room.server = serverMappings[doc.irc_addr];
            }
            room.channel = doc.irc_chan;
            room.roomId = doc.room_id;
            rooms.push(room);
        }
        return rooms;
    })
    return d.promise;
};

module.exports.getRoomsForChannel = function(server, channel) {
    var d = q.defer();
    select(db.collection("rooms"), d, {
        irc_addr: server.domain,
        irc_chan: channel
    }, true, function(docs) {
        var rooms = [];
        for (var i=0; i<docs.length; i++) {
            var doc = docs[i];
            var room = new Room();
            room.roomId = doc.room_id;
            room.server = server;
            room.channel = channel;
            rooms.push(room);
        }
        return rooms;
    });
    return d.promise;
};

module.exports.getTrackedChannelsForServer = function(ircAddr) {
    var d = q.defer();
    select(db.collection("rooms"), d, {
        irc_addr: ircAddr
    }, true, function(docs) {
        var channels = [];
        for (var i=0; i<docs.length; i++) {
            if (docs[i].irc_chan && docs[i].irc_chan.indexOf("#") === 0) {
                channels.push(docs[i].irc_chan);
            }
        }
        return channels;
    })
    return d.promise;
};

/*
 * Creates the mappings specified in the config and remembers the server to
 * return.
 */
module.exports.setServerFromConfig = function(server, opts) {
    serverMappings[server.domain] = server;

    if (opts && opts.rooms && opts.rooms.mappings) {
        var channels = Object.keys(opts.rooms.mappings);
        for (var i=0; i<channels.length; i++) {
            var channel = channels[i];

            if (typeof opts.rooms.mappings[channel] === "string") {
                opts.rooms.mappings[channel] = [opts.rooms.mappings[channel]]
            }
            for (var k=0; k<opts.rooms.mappings[channel].length; k++) {
                var room = new Room();
                room.server = server;
                room.channel = channel;
                room.roomId = opts.rooms.mappings[channel][k];
                module.exports.storeRoom(room, true);
            }
        }
    }
};

// removes all mappings with from_config = true
module.exports.removeConfigMappings = function() {
    var d = q.defer();
    log.info("removeConfigMappings");
    del(db.collection("rooms"), d, { from_config: true });
    return d.promise;
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
var insert = function(collection, d, objects) {
    collection.insert(objects, function(err, result) {
        callbackFn(d, err, result);
    });
};
var upsert = function(collection, d, query, update) {
    collection.update(query, update, {upsert: true}, function(err, result) {
        callbackFn(d, err, result);
    });
};
var del = function(collection, d, query) {
    collection.remove(query, function(err, result) {
        log.info("Removed %s entries", JSON.stringify(result));
        callbackFn(d, err, result);
    });
};
var select = function(collection, d, query, multiple, transformFn) {
    if (multiple) {
        collection.find(query).toArray(function(err, docs) {
            callbackFn(d, err, transformFn ? transformFn(docs) : docs);
        });
    }
    else {
        collection.findOne(query, function(err, docs) {
            callbackFn(d, err, transformFn ? transformFn(docs) : docs);
        });
    }
};