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

var getNickForUserId = function(server, userId) {
    if (userId.indexOf("@"+server.userPrefix) !== 0) {
        return;
    }
    var nickAndDomain = userId.substring(("@"+server.userPrefix).length);
    return nickAndDomain.split(":")[0];
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

module.exports.createIrcNickForUserId = function(userId) {
	// TODO handle nick clashes.
    // localpart only for now
    return userId.substring(1).split(":")[0];
};

module.exports.createUserLocalpartForServerNick = function(server, nick) {
	return server.userPrefix+nick;
};