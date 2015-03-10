"use strict";

function IrcServer(domain, opts) {
	this.domain = domain;
	this.nick = opts && opts.nick ? opts.nick : "matrixASbot";
	this.channelToRoomIds = {};
	var prefix;

	if (opts && opts.rooms) {
		var channels = Object.keys(opts.rooms);
		for (var i=0; i<channels.length; i++) {
			var channel = channels[i];
			if (channel === "*" && typeof opts.rooms["*"] === "string") {
				prefix = opts.rooms["*"];
				// strip leading #
				if (prefix.indexOf("#") === 0) {
					prefix = prefix.substring(1);
				}
				this.aliasPrefix = prefix;
				continue;
			}

			if (typeof opts.rooms[channel] === "string") {
				opts.rooms[channel] = [opts.rooms[channel]]
			}

			this.channelToRoomIds[channel] = opts.rooms[channel];
		}
	}

	if (opts && typeof opts.virtualUserPrefix === "string") {
		prefix = opts.virtualUserPrefix;
		if (prefix.indexOf("@") === 0) {
			prefix = prefix.substring(1);
		}
		this.userPrefix = prefix;
	}
	else {
		// user prefix is just going to be the IRC domain with an _
		// e.g. @irc.freenode.net_Alice:homserver.com
		this.userPrefix = this.domain + "_";
	}
};

IrcServer.prototype.shouldMapAllRooms = function() {
	return this.aliasPrefix !== undefined;
};

module.exports.IrcServer = IrcServer;