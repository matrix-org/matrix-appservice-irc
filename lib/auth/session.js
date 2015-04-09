"use strict";

var crypto = require("crypto");

function Session(userId, ircNetwork, opts) {
    this.userId = userId;
    this.network = ircNetwork;
    opts = opts || {};
    this.token = opts.token || crypto.randomBytes(32).toString('hex');
    this.auth = opts.auth || {};
};

Session.prototype = {
    setAuth: function(authType, username, timeAuthedForSecs, authedAtTs) {
        this.auth.type = authType;
        this.auth.username = username;
        this.auth.ts = authedAtTs || Date.now();
        this.auth.lifetime = timeAuthedForSecs;
    },

    isAuthed: function() {
        if (!this.auth.username) {
            return false;
        }
        if (!this.auth.lifetime) {
            return true; // no time limit to the auth
        }
        return Date.now() < (this.auth.lifetime + this.auth.ts);
    }
};

module.exports = Session;