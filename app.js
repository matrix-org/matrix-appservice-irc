// when invoked with 'node app.js', make an AS with just the IRC service.
var appservice = require("matrix-appservice");
var irc = require("./lib/irc-appservice.js");

// load the config file
var yaml = require("js-yaml");
var fs = require("fs");
var config = undefined;

try {
    config = yaml.safeLoad(fs.readFileSync('./config.yaml', 'utf8'));
} 
catch (e) {
    console.error(e);
    return;
}

irc.configure(config.ircService);

config.appService.service = irc;
appservice.registerServices([config.appService]);

appservice.runForever();
