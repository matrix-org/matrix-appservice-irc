/*
 * Hosts the web server to accept auth redirections.
 */
"use strict";

var express = require("express");
var morgan = require("morgan");
var url = require("url");

var auth = require("./base");
var log = require("../logging").get("auth-server");
var app = express();
var server = null;

app.use(morgan("combined", {
    stream: {
        write: function(str) {
            log.info(str.replace(/\n/g, " "));
        }
    }
}));

module.exports.redirectBase = null;
module.exports.run = function(redirectBase, port) {
    module.exports.redirectBase = redirectBase;

    // extract path segment e.g. /foo/bar in https://example.com/foo/bar
    // then suffix room for the session token.
    var redirectUrl = url.parse(redirectBase);
    var path = redirectUrl.path;
    var suffix = path[path.length-1] == '/' ? ":token" : "/:token";
    app.get(redirectUrl.path + suffix, function(req, res) {
        var token = req.params.token;
        // TODO OAuth 2
        // TODO Configurable success/failure pages.
        var ticket = req.query.ticket;
        auth.validate(token, ticket).done(function(session) {
            var response = "Success! You are authorized as "+session.auth.username;
            log.info("token=%s response=%s", token, response);
            res.send(response);
        }, function(err) {
            log.info("token=%s response=%s", token, JSON.stringify(err));
            res.send(err.msg);
        });
    });
    
    server = app.listen(port, function() {
        log.info("Redirect base: %s -- Listening at %s on port %s",
            redirectBase, server.address().address, server.address().port);
    });
}