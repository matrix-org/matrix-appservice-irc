/*
 * Contains the ID mapping functions to and from IRC/Matrix.
 */
"use strict";

var getServerForUserId = function(userId, servers) {
    for (var i=0; i<servers.length; i++) {
        var server = servers[i];
        if (userId.indexOf("@"+server.userPrefix) === 0) {
            return server;
        }
    }
};

var getServerForAlias = function(alias, servers) {
    for (var i=0; i<servers.length; i++) {
        var server = servers[i];
        if (alias.indexOf("#"+server.aliasPrefix) === 0) {
            return server;
        }
    }
};

var getNickForUserId = function(server, userId) {
    if (userId.indexOf("@"+server.userPrefix) !== 0) {
        return;
    }
    var nickAndDomain = userId.substring(("@"+server.userPrefix).length);
    return nickAndDomain.split(":")[0];
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

module.exports.userIdToServerNick = function(userId, servers) {
	var server = getServerForUserId(userId, servers);
	if (!server) {
		return {};
	}
	var nick = getNickForUserId(server, userId);
	return {
		server: server,
		nick: nick
	};
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

module.exports.createUserLocalpartForServerNick = function(server, nick) {
	return server.userPrefix+nick;
};