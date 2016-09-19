/*
 * Helper class for cleaning nedb state
 */
"use strict";
var Promise = require("bluebird");
var fs = require("fs");

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
            try {
                // nuke the world
                fs.unlinkSync(dbPath);
                resolve();
            }
            catch (err) {
                if (err.code === "ENOENT") {
                    resolve(); // already deleted
                }
                else {
                    reject(err);
                }
            }
        });
    }

    return Promise.all([
        delDatabase("/rooms.db"),
        delDatabase("/users.db"),
    ]);
};
