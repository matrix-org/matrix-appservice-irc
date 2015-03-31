// when invoked with 'node app.js', make an AS with just the IRC service.
var appservice = require("matrix-appservice");
var irc = require("./lib/irc-appservice.js");

// load the config file
var yaml = require("js-yaml");
var fs = require("fs");
var config = undefined;
var generateRegistration = process.argv[2] == "--generate-registration";

try {
    config = yaml.safeLoad(fs.readFileSync('./config.yaml', 'utf8'));
} 
catch (e) {
    console.error(e);
    return;
}
irc.configure(config.ircService);

config.appService.service = irc;
config.appService.shouldStartup = !generateRegistration;
appservice.registerServices([config.appService]);

if (generateRegistration) {
    var fname = "appservice-registration-irc.yaml";
    console.log("Generating registration file to %s...", fname);
    appservice.getRegistrations().done(function(entries) {
        var registration = entries[0];
        fs.writeFile(fname, yaml.safeDump(registration), function(e) {
            if (e) {
                console.error("Failed to write registration file: %s", e);
                return;
            }
            console.log("Generated registration file located at: %s", fname);
            process.exit(code=0);
        });
    });
}
else {
    appservice.runForever();
}
