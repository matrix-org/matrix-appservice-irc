/*
 * Helper class for cleaning nedb state
 */
"use strict";
var q = require("q");
var fs = require("fs");

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

    var roomDefer = q.defer();
    fs.unlink(baseDbName + "/rooms.db", function(e) {
        if (e) { console.error("rooms.db => %s", e); }
        roomDefer.resolve();
    });

    var configDefer = q.defer();
    fs.unlink(baseDbName + "/config.db", function(e) {
        if (e) { console.error("config.db => %s", e); }
        configDefer.resolve();
    });

    var usersDefer = q.defer();
    fs.unlink(baseDbName + "/users.db", function(e) {
        if (e) { console.error("users.db => %s", e); }
        usersDefer.resolve();
    });

    var ircClientDefer = q.defer();
    fs.unlink(baseDbName + "/irc_clients.db", function(e) {
        if (e) { console.error("irc_clients.db => %s", e); }
        ircClientDefer.resolve();
    });
    return q.all(roomDefer, configDefer, usersDefer, ircClientDefer);
};
