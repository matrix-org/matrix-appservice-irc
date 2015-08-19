"use strict";
var nopt = require("nopt");
var q = require("q");
var request = require("request");
var joinUrl = require("url").resolve;

var opts = nopt({
    "room-alias": String,
    "appservice-token": String,
    "msg": String,
    "url": String,
    "help": Boolean
}, {
    "h": "--help"
});

if (!opts["room-alias"] || !opts["appservice-token"] || !opts.url) {
    opts.help = true;
}

if (opts.help) {
    console.log("Unbridge a dynamically created room with an alias");
    console.log();
    console.log("This will DELETE the alias->room_id mapping and make the room's");
    console.log("join_rules: invite. You can optionally send a message in this");
    console.log("room to tell users that they should re-join via the alias.");
    console.log("This script does NOT create a new room. It relies on the AS to");
    console.log("do this via onAliasQuery pokes.");
    console.log();
    console.log("Usage:");
    console.log("unbridge.js --url BASEURL --room-alias ALIAS --appservice-token TOKEN [--admin-token TOKEN] [--msg MESSAGE]");
    console.log();
    console.log("--url               The home server base URL e.g. https://matrix.org");
    console.log("--room-alias        The alias to unbridge.");
    console.log("--appservice-token  The AS token. Used to set join_rules in the room.");
    console.log("--msg               Optional. The message to send to the room.");
    process.exit(0);
    return;
}

// admin token is always the AS token since it's "exclusively" claimed.
main(
    opts.url, opts["room-alias"], opts["appservice-token"], opts["appservice-token"],
    opts.msg
);

function main(url, alias, astoken, admintoken, msg) {
    console.log("Unbridging %s", alias);
    var roomId = null;
    getIdForAlias(url, alias).then(function(id) {
        roomId = id;
        if (!id) {
            panic("No room ID!");
        }
        console.log("Resolved %s to %s", alias, id);
        return deleteAlias(url, alias, admintoken);
    }).then(function() {
        console.log("Deleted alias %s", alias);
        return setInviteJoinRules(url, roomId, astoken);
    }).then(function() {
        console.log("Made room %s join_rules: invite", roomId);
        return sendMessage(url, roomId, astoken, msg);
    }).done(function() {
        console.log("Sent optional message.");
        console.log("Success.");
    }, panic);
}

function getIdForAlias(url, alias) {
    var d = q.defer();
    var encAlias = encodeURIComponent(alias);
    request.get(
        joinUrl(url, "/_matrix/client/api/v1/directory/room/" + encAlias),
        function(err, res, body) {
            if (isRejected(d, err, res, "Failed to get ID for alias")) {
                return;
            }
            try {
                d.resolve(JSON.parse(body).room_id);
            }
            catch (e) {
                d.reject(e);
            }
        }
    );
    return d.promise;
}

function deleteAlias(url, alias, token) {
    var d = q.defer();
    var encAlias = encodeURIComponent(alias);
    request({
        url: joinUrl(
            url, "/_matrix/client/api/v1/directory/room/" + encAlias
        ) + "?access_token=" + token,
        method: "DELETE"
    }, function(err, res, body) {
        if (isRejected(d, err, res, "Failed to delete room alias")) {
            return;
        }
        d.resolve();
    });
    return d.promise;
}

function setInviteJoinRules(url, roomId, token) {
    var d = q.defer();
    var encRoomId = encodeURIComponent(roomId);
    request({
        url: joinUrl(
            url, "/_matrix/client/api/v1/rooms/" + encRoomId + "/state/m.room.join_rules"
        ) + "?access_token=" + token,
        body: {
            join_rule: "invite"
        },
        json: true,
        method: "PUT"
    }, function(err, res, body) {
        if (isRejected(d, err, res, "Failed to set invite join_rules")) {
            return;
        }
        d.resolve();
    });
    return d.promise;
}

function sendMessage(url, roomId, token, msg) {
    if (!msg) {
        console.log("No message provided. Skipping.");
        return q();
    }
    var d = q.defer();
    var encRoomId = encodeURIComponent(roomId);
    request({
        url: joinUrl(
            url, "/_matrix/client/api/v1/rooms/" + encRoomId + "/send/m.room.message"
        ) + "?access_token=" + token,
        body: {
            msgtype: "m.notice",
            body: "" + msg // typecast
        },
        json: true,
        method: "POST"
    }, function(err, res, body) {
        if (isRejected(d, err, res, "Failed to send message")) {
            return;
        }
        d.resolve();
    });
    return d.promise;
}

function isRejected(defer, err, res, msg) {
    if (err) {
        defer.reject(err);
        return true;
    }
    else if (res.statusCode >= 300) {
        console.error(res.body);
        defer.reject(new Error("HTTP Status: " + res.statusCode + " : " + msg));
        return true;
    }
    return false;
}

function panic(err) {
    console.error(err.stack);
    console.log("FAILED");
    console.error(err);
    process.exit(1);
}
