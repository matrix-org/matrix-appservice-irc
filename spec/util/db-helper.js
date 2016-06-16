/*
 * Helper class for cleaning nedb state
 */
"use strict";
var Promise = require("bluebird");
var fs = require("fs");
var promiseutil = require("../../lib/promiseutil");
var Datastore = require("nedb");

/**
 * Reset the database, wiping all data.
 * @param {String} databaseUri : The database URI to wipe all data from.
 * @return {Promise} Which is resolved when the database has been cleared.
 */
module.exports._reset = function(databaseUri) {
    if (databaseUri.indexOf("nedb://") !== 0) {
        return Promise.reject("Must be nedb:// URI");
    }
    var baseDbName = databaseUri.substring("nedb://".length);

    function delDatabase(name) {
        var dbPath = baseDbName + name;
        return new Promise(function(resolve, reject) {
            // nuke the world
            fs.unlink(dbPath, function(err) {
                if (err) {
                    if (err.code == "ENOENT") { // already deleted
                        resolve();
                    }
                    else {
                        reject(err);
                    }
                }
                else {
                    resolve();
                }
            });
            
        });
    }

    return Promise.all([
        delDatabase("/rooms.db"),
        delDatabase("/users.db"),
    ]);
};
