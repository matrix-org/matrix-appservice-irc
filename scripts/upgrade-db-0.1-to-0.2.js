#!/usr/bin/env node
"use strict";

var Promise = require("bluebird");
var Datastore = require("nedb");
Promise.promisifyAll(Datastore.prototype);
var nopt = require("nopt");
var path = require("path");
var fs = require("fs");

const ROOM_DB = "0.2-db/rooms.db";
const USER_DB = "0.2-db/users.db"

var opts = nopt({
    "help": Boolean,
    rooms: path,
    users: path,
    clients: path
}, {
    "h": "--help"
});

if (!opts.help && (!opts.rooms || !opts.users || !opts.clients)) {
    console.log("--rooms, --clients and --users are required.");
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
   --users   The path to users.db. Required.
   --clients The path to irc_clients.db. Required.`
);
process.exit(0);
}


var upgradeUsers = Promise.coroutine(function*(usersDb, clientDb) {
    console.log("Upgrading users database");
    // 0.1 users.db => user_id, localpart, display_name, set_display_name
    // 0.1 irc_clients.db => user_id, domain, nick, username
    var users = yield usersDb.findAsync({});
    var clients = yield clientDb.findAsync({});

    var userMap = {};
    users.forEach((user) => {
        userMap[user.user_id] = user;
    });
    clients.forEach((client) => {
        var user = userMap[client.user_id];
        if (!user) {
            userMap[client.user_id] = {
                user_id: client.user_id
            };
            user = userMap[client.user_id];
        }
        if (user.client) {
            console.warn("Found multiple clients for %s - dropping one.", client.user_id);
        }
        user.client = client;
    });
    // 0.2 users.db => type=matrix, id=<user_id>
    //                 data={
    //                   client_config: { "irc_network": {nick=Nick, username=Username} }
    //                   localpart: <localpart>
    //                 }
    var newUserStore = new Datastore({
        filename: USER_DB,
        autoload: true
    });
    var insertions = Object.keys(userMap).map((userId) => {
        var user = userMap[userId];
        var config = undefined;
        if (user.client) {
            config = {
                [user.client.domain.replace(/\./g, "_")]: {
                    nick: user.client.nick,
                    username: user.client.username
                }
            }
        }
        return {
            type: "matrix",
            id: userId,
            data: {
                localpart: user.localpart,
                client_config: config
            }
        };
    });

    yield newUserStore.insertAsync(insertions);
});

var upgradeRooms = Promise.coroutine(function*(db) {
    console.log("Upgrading rooms database");
    // 0.1 rooms.db =>
    // room_id, irc_addr(domain), irc_chan, from_config, type(channel)      CHANNELS
    // user_id, type(admin), room_id                                        ADMIN
    // real_user_id, virtual_user_id, room_id, irc_addr, irc_chan, type(pm) PM
    var rooms = yield db.findAsync({});

    // 0.2 rooms.db =>
    // CHANNELS
    // type=matrix, id=<room_id>  data={extras:{}}  -- UNIQUE(id)
    // type=remote, id=<domain_@_chan> data={domain,channel,type(channel)}  -- UNIQUE(id)
    // type=union, link_key=<room_id remote_id>, remote_id, matrix_id, data:{from_config}
    //
    // ADMIN
    // type=matrix, id=<room_id> data={extras:{admin_id:<user_id>}}
    //
    // PM
    // type=matrix, id=<room_id>  data={extras:{}}
    // type=remote, id=<domain_@_nick> data={domain,channel,type(pm)}
    // type=union, link_key="PM real_user_id virt_user_id", remote_id, matrix_id,
    //                                                      data={real_user_id, virtual_user_id}
    var newRoomStore = new Datastore({
        filename: ROOM_DB,
        autoload: true
    });
    var insertions = [];
    var matrixRoomsAdded = new Set();
    var remoteRoomsAdded = new Set();
    rooms.forEach((room) => {
        switch (room.type) {
            case "pm":
                var remote_id = room.irc_addr + "_@_" + room.irc_chan;
                if (!matrixRoomsAdded.has(room.room_id)) {
                    matrixRoomsAdded.add(room.room_id);
                    insertions.push({
                        type: "matrix", id: room.room_id, data: {
                            extras: {}
                        }
                    });
                }
                if (!remoteRoomsAdded.has(remote_id)) {
                    remoteRoomsAdded.add(remote_id);
                    insertions.push({
                        type: "remote", id: remote_id, data: {
                            domain: room.irc_addr,
                            channel: room.irc_chan,
                            type: "pm"
                        }
                    });
                }
                insertions.push({
                    type: "union", link_key: "PM " + room.real_user_id + " " + room.virtual_user_id,
                    remote_id: remote_id, matrix_id: room.room_id, data: {
                        real_user_id: room.real_user_id,
                        virtual_user_id: room.virtual_user_id,
                    }
                });
                break;
            case "channel":
                var remote_id = room.irc_addr + "_@_" + room.irc_chan;
                if (!matrixRoomsAdded.has(room.room_id)) {
                    matrixRoomsAdded.add(room.room_id);
                    insertions.push({
                        type: "matrix", id: room.room_id, data: {
                            extras: {}
                        }
                    });
                }
                if (!remoteRoomsAdded.has(remote_id)) {
                    remoteRoomsAdded.add(remote_id);
                    insertions.push({
                        type: "remote", id: remote_id, data: {
                            domain: room.irc_addr,
                            channel: room.irc_chan,
                            type: "channel"
                        }
                    });
                }
                // type=union, link_key=<room_id remote_id>, remote_id, matrix_id, data:{from_config}
                insertions.push({
                    type: "union", link_key: room.room_id + " " + remote_id,
                    remote_id: remote_id, matrix_id: room.room_id, data: {
                        from_config: room.from_config
                    }
                });
                break;
            case "admin":
                if (!matrixRoomsAdded.has(room.room_id)) {
                    matrixRoomsAdded.add(room.room_id);
                    insertions.push({
                        type: "matrix", id: room.room_id, data: {
                            extras: {
                                admin_id: room.user_id
                            }
                        }
                    });
                }
                break;
            default:
                throw new Error("Unknown room type " + room.type);
        }
    });
    yield newRoomStore.insertAsync(insertions);
});

Promise.coroutine(function*() {
    try {
        fs.mkdirSync("0.2-db");
    }
    catch (err) {
        if (err.code !== "EEXIST") { throw err; }
        try { fs.unlinkSync(ROOM_DB); } catch (e) {}
        try { fs.unlinkSync(USER_DB); } catch (e) {}
    }
    var userStore = new Datastore({
        filename: opts.users,
        autoload: true
    });
    var clientStore = new Datastore({
        filename: opts.clients,
        autoload: true
    });
    yield upgradeUsers(userStore, clientStore);
    var roomStore = new Datastore({
        filename: opts.rooms,
        autoload: true
    });
    yield upgradeRooms(roomStore);
    console.log("Upgrade complete.");
})();