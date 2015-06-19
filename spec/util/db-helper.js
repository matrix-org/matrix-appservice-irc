/*
 * Helper class for cleaning nedb state
 */
"use strict";
var q = require("q");
var Datastore = require("nedb");

var deleteDb = function(db, query) {
    var defer = q.defer();
    db.remove(query, {multi: true}, function(err, docs) {
        if (err) {
            defer.reject(err);
            return;
        }
        defer.resolve(docs);
    });
    return defer.promise;
};

/**
 * Reset the database, wiping all data.
 * @param {String} databaseUri : The database URI to wipe all data from.
 * @return {Promise} Which is resolved when the database has been cleared.
 */
module.exports._reset = function(databaseUri) {
    var d = q.defer();
    if (databaseUri.indexOf("nedb://") !== 0) {
        return q.reject("Must be nedb:// URI");
    }
    var baseDbName = databaseUri.substring("nedb://".length);

    var configWiped, roomsWiped, usersWiped = false;

    var roomsDb = new Datastore({
        filename: baseDbName + "/rooms.db",
        autoload: true,
        onload: function() {
            deleteDb(roomsDb, {}).done(function() {
                roomsWiped = true;
                if (configWiped && roomsWiped && usersWiped) {
                    d.resolve();
                }
            });
        }
    });
    var configDb = new Datastore({
        filename: baseDbName + "/config.db",
        autoload: true,
        onload: function() {
            deleteDb(configDb, {}).done(function() {
                configWiped = true;
                if (configWiped && roomsWiped && usersWiped) {
                    d.resolve();
                }
            });
        }
    });
    var usersDb = new Datastore({
        filename: baseDbName + "/users.db",
        autoload: true,
        onload: function() {
            deleteDb(usersDb, {}).done(function() {
                usersWiped = true;
                if (configWiped && roomsWiped && usersWiped) {
                    d.resolve();
                }
            });
        }
    });
    return d.promise;
};
