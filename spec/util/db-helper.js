/*
 * Helper class for checking MongoDB state
 */
 "use strict";
 var q = require("q");
 var MongoClient = require("mongodb").MongoClient;

 var dbDefer = null;
 var db = null;

 module.exports.connectTo = function(databaseUri) {
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

 module.exports.select = function(collectionName, query) {
    var d = q.defer();
    db.collection(collectionName).find(query).toArray(function(err, docs) {
        if (err) {
            d.reject(err);
        }
        else {
            d.resolve(docs);
        }
    });
    return d.promise;
 };

 module.exports.delete = function(collectionName, query) {
    var d = q.defer();
    db.collection(collectionName).remove(query, function(err, docs) {
        if (err) {
            d.reject(err);
        }
        else {
            d.resolve(docs);
        }
    });
    return d.promise;
 };

 module.exports._reset = function() {
    dbDefer = null;
    if (db) {
        db.close();
    }
    db = null;
 };