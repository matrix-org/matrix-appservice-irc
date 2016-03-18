#!/usr/bin/env node
"use strict";

var Promise = require("bluebird");
var nopt = require("nopt");
var path = require("path");
var fs = require("fs");

var opts = nopt({
    "help": Boolean,
    rooms: path,
    users: path
}, {
    "h": "--help"
});

if (!opts.help && (!opts.rooms || !opts.users)) {
    console.log("--rooms and --users are required.");
    opts.help = true;
}

if (opts.help) {
    console.log(
`Database Upgrade script (v0.1 => v0.2)
--------------------------------------
If you have an existing database from the previous release, it will not work
with v0.2. To upgrade the database, run this script. v0.2-ready database files
will be dumped to a directory called "0.2-db" in the current working directory.

 Usage:
   --rooms   The path to rooms.db. Required.
   --users   The path to users.db. Required.`
);
process.exit(0);
}


var upgradeUsers = Promise.coroutine(function*(dbPath) {
    console.log("Upgrading users database: %s", dbPath);
});

var upgradeRooms = Promise.coroutine(function*(dbPath) {
    console.log("Upgrading rooms database: %s", dbPath);
});

Promise.coroutine(function*() {
    try {
        fs.mkdirSync("0.2-db");
    }
    catch (err) {
        if (err.code !== "EEXIST") { throw err; }
    }
    yield upgradeUsers(opts.users);
    yield upgradeRooms(opts.rooms);
    console.log("Upgrade complete.");
})();