/*
 * Helper class for cleaning nedb state
 */
 "use strict";
 var q = require("q");
 var Datastore = require("nedb");

 var deleteDb = function(db, query) {
    var defer = q.defer();
    db.remove(query, {multi:true}, function(err, docs) {
        if (err) {
            defer.reject(err);
            return;
        }
        defer.resolve(docs);
    });
    return defer.promise;
 };

 module.exports._reset = function(databaseUri) {
    var d = q.defer();
    if (databaseUri.indexOf("nedb://") !== 0) {
        return q.reject("Must be nedb:// URI");
    }
    var baseDbName = databaseUri.substring("nedb://".length);

    var configWiped, roomsWiped = false;

    var roomsDb = new Datastore({
        filename: baseDbName + "/rooms.db",
        autoload: true,
        onload: function() {
            deleteDb(roomsDb, {}).done(function() {
                roomsWiped = true;
                if (configWiped && roomsWiped) {
                    d.resolve();
                }
            })
        }
    });
    var configDb = new Datastore({
        filename: baseDbName + "/config.db",
        autoload: true,
        onload: function() {
            deleteDb(configDb, {}).done(function() {
                configWiped = true;
                if (configWiped && roomsWiped) {
                    d.resolve();
                }
            })
        }
    });
    return d.promise;
 };