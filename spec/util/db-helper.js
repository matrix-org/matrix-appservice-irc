/*
 * Helper class for cleaning nedb state
 */
"use strict";
var q = require("q");
var Datastore = require("nedb");

/**
 * Reset the database, wiping all data.
 * @param {String} databaseUri : The database URI to wipe all data from.
 * @return {Promise} Which is resolved when the database has been cleared.
 */
module.exports._reset = function(databaseUri) {
    if (databaseUri.indexOf("nedb://") !== 0) {
        return q.reject("Must be nedb:// URI");
    }
    var baseDbName = databaseUri.substring("nedb://".length);

    function delDatabase(name) {
        var d = q.defer();
        var db = new Datastore({
            filename: baseDbName + name,
            autoload: true,
            onload: function() {
                db.remove({}, {multi: true}, function(err, docs) {
                    if (err) {
                        console.error("db-helper %s Failed to delete: %s", name, err);
                        console.error(err.stack);
                        d.reject(err);
                        return;
                    }
                    d.resolve(docs);
                });
            }
        });
        return d.promise;
    }

    return q.allSettled([
        delDatabase("/config.db"),
        delDatabase("/irc_clients.db"),
        delDatabase("/rooms.db"),
        delDatabase("/users.db")
    ]);
};
