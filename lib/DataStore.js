/*eslint no-invalid-this: 0*/ // eslint doesn't understand Promise.coroutine wrapping
"use strict";

var Promise = require("bluebird");

var MatrixRoom = require("matrix-appservice-bridge").MatrixRoom;
// var MatrixUser = require("matrix-appservice-bridge").MatrixUser;
// var IrcUser = require("./models/IrcUser");
var IrcRoom = require("./models/IrcRoom");
var log = require("./logging").get("DataStore");

function DataStore(userStore, roomStore) {
    this._roomStore = roomStore;
    this._userStore = userStore;
    this._serverMappings = {}; // { domain: IrcServer }
}

DataStore.prototype.setServerFromConfig = Promise.coroutine(function*(server, serverConfig) {
    this._serverMappings[server.domain] = server;

    var channels = Object.keys(serverConfig.mappings);
    for (var i = 0; i < channels.length; i++) {
        var channel = channels[i];
        for (var k = 0; k < serverConfig.mappings[channel].length; k++) {
            var ircRoom = new IrcRoom(server, channel);
            var mxRoom = new MatrixRoom(
                serverConfig.mappings[channel][k]
            );
            yield this.storeRoom(ircRoom, mxRoom, true);
        }
    }
});

/**
 * Persists an IRC <--> Matrix room mapping in the database.
 * @param {IrcRoom} ircRoom : The IRC room to store.
 * @param {MatrixRoom} matrixRoom : The Matrix room to store.
 * @param {boolean} fromConfig : True if this mapping is from the config yaml.
 * @return {Promise}
 */
DataStore.prototype.storeRoom = function(ircRoom, mxRoom, fromConfig) {
    fromConfig = Boolean(fromConfig);
    log.info("storeRoom (id=%s, addr=%s, chan=%s, config=%s)",
        matrixRoom.getId(), ircRoom.get("domain"), ircRoom.channel, fromConfig);
    return this._roomStore.linkRooms(mxRoom, ircRoom, {
        fromConfig: fromConfig
    });
};

/**
 * Retrieve a list of IRC rooms for a given room ID.
 * @param {string} roomId : The room ID to get mapped IRC channels.
 * @return {Promise<Array<IrcRoom>>} A promise which resolves to a list of
 * rooms.
 */
DataStore.prototype.getIrcChannelsForRoomId = function(roomId) {
    return this._roomStore.getLinkedRemoteRooms(roomId).then((remoteRooms) => {
        return remoteRooms.filter((remoteRoom) => {
            return Boolean(this._serverMappings[remoteRoom.get("domain")]);
        }).map((remoteRoom) => {
            let server = this._serverMappings[remoteRoom.get("domain")];
            return IrcRoom.fromRemoteRoom(server, remoteRoom);
        });
    });
};

/**
 * Retrieve a list of Matrix rooms for a given server and channel.
 * @param {IrcServer} server : The server to get rooms for.
 * @param {string} channel : The channel to get mapped rooms for.
 * @return {Promise<Array<MatrixRoom>>} A promise which resolves to a list of rooms.
 */
DataStore.prototype.getMatrixRoomsForChannel = function(server, channel) {
    channel = toIrcLowerCase(channel); // all stored in lower case
    return this._roomStore.getLinkedMatrixRooms(IrcRoom.createId(server, channel));
};

DataStore.prototype.setPmRoom = function(ircRoom, matrixRoom, userId, virtualUserId) {
    /*
    log.info("setPmRoom (id=%s, addr=%s chan=%s real=%s virt=%s)",
        matrixRoom.getId(), ircRoom.server.domain, ircRoom.channel, userId,
        virtualUserId);

    upsert(getCollection("rooms"), d, {
        real_user_id: userId,
        virtual_user_id: virtualUserId
    },
    {
        $set: {
            room_id: matrixRoom.getId(),
            irc_addr: addr,
            irc_chan: toIrcLowerCase(ircRoom.channel),
            type: "pm",
            real_user_id: userId,
            virtual_user_id: virtualUserId
        }
    });
    return d.promise; */
};


module.exports = DataStore;
