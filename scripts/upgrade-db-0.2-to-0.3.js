#!/usr/bin/env node
"use strict";

var Promise = require("bluebird");
var Datastore = require("nedb");
Promise.promisifyAll(Datastore.prototype);
var nopt = require("nopt");
var path = require("path");
var fs = require("fs");

const ROOM_DB = "0.3-db/rooms.db";
const USER_DB = "0.3-db/users.db"

var opts = nopt({
    "help": Boolean,
    rooms: path,
    users: path,
}, {
    "h": "--help"
});

if (!opts.help && (!opts.rooms || !opts.users)) {
    console.log("--rooms and --users are required.");
    opts.help = true;
}

if (opts.help) {
    console.log(
`Database Upgrade script (v0.2 => v0.3)
--------------------------------------
If you have an existing database from the develop branch (unreleased onto master),
it will not work with v0.3. To upgrade the database, run this script.
v0.3-ready database files will be dumped to a directory called "0.3-db" in the
current working directory.

 Usage:
   --rooms   The path to rooms.db. Required.
   --users   The path to users.db. Required.`
);
process.exit(0);
}


var upgradeUsers = Promise.coroutine(function*(usersDb) {
    console.log("Upgrading users database"); // TODO
});

var upgradeRooms = Promise.coroutine(function*(db) {
    console.log("Upgrading rooms database");
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
    //
    //
    // 0.3 rooms.db =>
    // CHANNELS
    // id=<room_id> <domain> <chan>, remote_id=<domain> <chan>, matrix_id=<room_id>
    //     remote={domain=<domain>, channel=<channel>, type="channel"}
    //     matrix={extras={}}
    //     data={from_config=true|false}
    //
    // ADMIN
    // id=ADMIN_<user_id>, matrix_id=<room_id>, matrix={extras={admin_id=<user_id>}}
    //
    // PM
    // id=PM_<user_id> <virt_user_id>, remote_id=<domain> <nick>, matrix_id=<room_id>
    //     remote={domain=<domain>, channel=<nick>, type="pm"}
    //     matrix={extras={}}
    //     data={real_user_id=<user_id>, virtual_user_id=<virt_user_id>}

    var entries = yield db.findAsync({});
    var newRoomStore = new Datastore({
        filename: ROOM_DB,
        autoload: true
    });
    var insertions = {}; // unique based on ID
    var matrixRooms = {
        // room_id: {data fields}
    };
    var ircChannels = {
        // domain_@_chan: {data fields}
    };

    // populate irc/matrix rooms for union types later
    entries.forEach(function(e) {
        switch (e.type) {
            case "matrix":
                if (matrixRooms[e.id]) {
                    throw new Error("Duplicate matrix id: " + e.id);
                }
                matrixRooms[e.id] = e.data;
                var data = e.data.extras || {};
                if (data.admin_id) {
                    // admin room
                    var id = "ADMIN_" + data.admin_id;
                    insertions[id] = {
                        id: "ADMIN_" + data.admin_id,
                        matrix_id: e.id,
                        matrix: e.data
                    };
                }
                break;
            case "remote":
                if (ircChannels[e.id]) {
                    throw new Error("Duplicate remote id: " + e.id);
                }
                ircChannels[e.id] = e.data;
                break;
        }
    });

    entries.forEach(function(e) {
        if (e.type !== "union") {
            return;
        }
        var roomId = e.matrix_id;
        var matrixData = matrixRooms[roomId];
        var remoteData = ircChannels[e.remote_id];
        if (!matrixData || !remoteData) {
            throw new Error("Missing matrix/remote data for union type: " + JSON.stringify(e));
        }

        if (e.link_key.indexOf("PM ") === 0) {
            if (remoteData.type !== "pm") {
                console.error("Expected remote data type to be 'pm' but was: " + remoteData.type + " entry: " + JSON.stringify(e));
                return;
            }
            var userId = e.data.real_user_id;
            var virtUserId = e.data.virtual_user_id;
            var domain = remoteData.domain;
            var nick = remoteData.channel;
            var id = "PM_" + userId + " " + virtUserId;
            insertions[id] = {
                id: id,
                remote_id: domain + " " + nick,
                matrix_id: roomId,
                remote: remoteData,
                matrix: matrixData,
                data: e.data
            };
        } else if (e.link_key.indexOf("!") === 0) { // normal channel
            var domain = remoteData.domain;
            var channel = remoteData.channel;
            var id = roomId + " " + domain + " " + channel;
            var splat = false;
            insertions[id] = {
                id: id,
                remote_id: domain + " " + channel,
                matrix_id: roomId,
                remote: remoteData,
                matrix: matrixData,
                data: e.data
            };
        } else {
            throw new Error("Unexpected link_key value for union type: " + e.link_key);
        }
    });

    var insertList = [];
    Object.keys(insertions).forEach(function(k) {
        insertList.push(insertions[k]);
    });

    yield newRoomStore.insertAsync(insertList);

    // if everything worked we should have globally unique 'id' values and sparse
    // non-unique matrix_id and remote_id
    try {
        yield newRoomStore.ensureIndexAsync({
            fieldName: "id",
            unique: true,
            sparse: false
        });
        yield newRoomStore.ensureIndexAsync({
            fieldName: "matrix_id",
            unique: false,
            sparse: true
        });
        yield newRoomStore.ensureIndexAsync({
            fieldName: "remote_id",
            unique: false,
            sparse: true
        });
    } catch (err) {
        console.error(JSON.stringify(err));
    }
});

Promise.coroutine(function*() {
    try {
        fs.mkdirSync("0.3-db");
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
    yield upgradeUsers(userStore);
    var roomStore = new Datastore({
        filename: opts.rooms,
        autoload: true
    });
    yield upgradeRooms(roomStore);
    console.log("Upgrade complete.");
})();