/*
 * Contains the ID mapping functions to and from IRC/Matrix.
 */
"use strict";

var getServerForAlias = function(alias, servers) {
    for (var i=0; i<servers.length; i++) {
        var server = servers[i];
        if (alias.indexOf("#"+server.aliasPrefix) === 0) {
            return server;
        }
    }
};

var getChannelForAlias = function(server, alias) {
    if (alias.indexOf("#"+server.aliasPrefix) !== 0) {
        return;
    }
    var chanAndDomain = alias.substring(("#"+server.aliasPrefix).length);
    if (chanAndDomain.indexOf("#") !== 0) {
        return; // not a channel.
    }
    return chanAndDomain.split(":")[0];
};

module.exports.aliasToServerChannel = function(alias, servers) {
	var server = getServerForAlias(alias, servers);
	if (!server) {
		return {};
	}
	var channel = getChannelForAlias(server, alias);
	return {
		server: server,
		channel: channel
	};
};

module.exports.createIrcNickForUserId = function(userId) {
	// TODO handle nick clashes.
    // localpart only for now
    return userId.substring(1).split(":")[0];
};