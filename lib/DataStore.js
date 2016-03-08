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



module.exports = DataStore;
