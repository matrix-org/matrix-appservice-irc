"use strict";
var Promise = require("bluebird");
var test = require("../util/test");
var env = test.mkEnv();
var config = env.config;

describe("Provisioning API", function() {
    var mxUser = {
        id: "@flibble:wibble",
        nick: "M-flibble"
    };

    var ircUser = {
        nick: "bob",
        localpart: config._server + "_bob",
        id: "@" + config._server + "_bob:" + config.homeserver.domain
    };

    beforeEach(function(done) {
        test.beforeEach(this, env); // eslint-disable-line no-invalid-this

        // accept connection requests from eeeeeeeeveryone!
        env.ircMock._autoConnectNetworks(
            config._server, mxUser.nick, config._server
        );
        env.ircMock._autoConnectNetworks(
            config._server, ircUser.nick, config._server
        );
        env.ircMock._autoConnectNetworks(
            config._server, config._botnick, config._server
        );
        // accept join requests from eeeeeeeeveryone!
        env.ircMock._autoJoinChannels(
            config._server, mxUser.nick, config._chan
        );
        env.ircMock._autoJoinChannels(
            config._server, ircUser.nick, config._chan
        );
        env.ircMock._autoJoinChannels(
            config._server, config._botnick, config._chan
        );

        // do the init
        test.initEnv(env).done(function() {
            done();
        });
    });

    let mockLink = function (parameters, shouldSucceed, link) {
        return test.coroutine(function*() {
            let json = jasmine.createSpy("json(obj)");
            let status = jasmine.createSpy("status(num)");

            // Defaults
            if (!parameters.matrix_room_id) {
                parameters.matrix_room_id = "!foo:bar";
            }
            if (!parameters.remote_room_server) {
                parameters.remote_room_server = "irc.example";
            }
            if (!parameters.remote_room_channel) {
                parameters.remote_room_channel = "#coffee";
            }

            // When the _link promise resolves
            let resolve = shouldSucceed ?
                // success is indicated with empty object
                () => { expect(json.calls[0].args[0]).toEqual({}); }:
                // failure with 500 and JSON error message
                () => {
                    expect(json).toHaveBeenCalled();
                    expect(status).toHaveBeenCalled();
                    expect(status.calls[0].args[0]).toEqual(500);
                    expect(json.calls[0].args[0].error).toBeDefined();
                };

            // When the _link fails
            let reject = shouldSucceed ?
                // but it should have succeeded
                (err) => { return Promise.reject(err) }: // propagate rejection
                // and it should have failed
                (err) => { expect(err).toBeDefined(); }; // error should be given

            return env.mockAppService._linkaction(
               parameters, status, json, link
            ).then(resolve, reject);
        });
    };

    describe("link endpoint", function() {

        it("should create a M<--->I link",
            mockLink({}, true, true)
        );

        it("should not create a M<--->I link when room_id is malformed",
            mockLink({matrix_room_id : '!f!!oo:ba::r'}, false, true));

        it("should not create a M<--->I link when remote_room_server is malformed",
            mockLink({remote_room_server : 'irc./example'}, false, true));

        it("should not create a M<--->I link when remote_room_channel is malformed",
            mockLink({remote_room_channel : 'coffe####e'}, false, true));
    });

    describe("unlink endpoint", function() {

        it("should remove a M<--->I link",
            mockLink({}, true, false)
        );

        it("should not remove a M<--->I link when room_id is malformed",
            mockLink({matrix_room_id : '!f!!oo:ba::r'}, false, false));

        it("should not remove a M<--->I link when remote_room_server is malformed",
            mockLink({remote_room_server : 'irc./example'}, false, false));

        it("should not remove a M<--->I link when remote_room_channel is malformed",
            mockLink({remote_room_channel : 'coffe####e'}, false, false));
    });
});
