/*
 * Provides storage for dynamically created IRC channel/room ID mappings, in
 * addition to other things like the home server token.
 */
"use strict";

var Promise = require("bluebird");
var promiseutil = require("./promiseutil");

var IrcUser = require("./models/IrcUser");
var log = require("./logging").get("database");

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
});

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
