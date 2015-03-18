/*
 * Provides storage for dynamically created IRC channel/room ID mappings, in
 * addition to other things like the home server token.
 */
"use-strict";
var q = require("q");
var MongoClient = require('mongodb').MongoClient;

var db = null;

module.exports.connectToDatabase = function(databaseUri) {
    console.log("connectToDatabase -> %s", databaseUri);
    var d = q.defer();
    if (db) {
        return q(db);
    }
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
            d.reject(err);
        } else {
            db = dbInst;
            d.resolve(db);
        }
    });
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
var select = function(collection, d, query, multiple) {
    if (multiple) {
        collection.find(query).toArray(function(err, docs) {
            callbackFn(d, err, docs);
        });
    }
    else {
        collection.findOne(query, function(err, docs) {
            callbackFn(d, err, docs);
        });
    }
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

module.exports.storeRoom = function(room) {
    var d = q.defer();
    insert(db.collection("rooms"), d, {
        room_id: room.roomId,
        irc_addr: room.server ? room.server.domain : undefined,
        irc_chan: room.channel
    });
    return d.promise;
};