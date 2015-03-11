"use strict";
var servers = [];
var hooks = {
	onMessage: function(server, from, to, msg){
		console.log("onMessage: Implement me!");
	}
};

// The list of bot clients on servers (not specific users)
var botClients = [];

module.exports.connect = function() {
	servers.forEach(function(server) {
		if (server.isTrackingChannels()) {
			// connect to the server as a bot so we can monitor chat in the
			// channels we're tracking.
			botClients.push(server.connect(hooks));
		}
	});
};

module.exports.trackChannel = function(server, channel) {
	// TODO: Track the channel
	// If we have a bot already on this server, just make them join the channel.
	// If we don't, then connect as a bot to this server, add it to botClients
	// and join the room.
};

module.exports.registerHooks = function(ircCallbacks) {
	hooks = ircCallbacks;
};

module.exports.setServers = function(ircServers) {
	servers = ircServers;
};