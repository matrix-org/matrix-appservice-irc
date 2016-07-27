"use strict";
var Promise = require("bluebird");
var test = require("../util/test");
var env = test.mkEnv();
var config = env.config;

describe("Kicking", function() {
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

        // we also don't care about registration requests for the irc user
        env.clientMock._client(ircUser.id)._onHttpRegister({
            expectLocalpart: ircUser.localpart,
            returnUserId: ircUser.id
        });

        // do the init
        test.initEnv(env).then(function() {
            // make the matrix user be on IRC
            return env.mockAppService._trigger("type:m.room.message", {
                content: {
                    body: "let me in",
                    msgtype: "m.text"
                },
                user_id: mxUser.id,
                room_id: config._roomid,
                type: "m.room.message"
            })
        }).then(function() {
            return env.ircMock._findClientAsync(config._server, config._botnick);
        }).then(function(botIrcClient) {
            // make the IRC user be on Matrix
            botIrcClient.emit("message", ircUser.nick, config._chan, "let me in");
            done();
        })
    });

    describe("IRC users on IRC", function() {

    });

    describe("Matrix users on Matrix", function() {
        it("should make the kickee part the IRC channel", function(done) {
            var parted = false;
            env.ircMock._whenClient(config._server, mxUser.nick, "part",
            function(client, channel, msg, cb) {
                expect(client.nick).toEqual(mxUser.nick);
                expect(client.addr).toEqual(config._server);
                expect(channel).toEqual(config._chan);
                expect(msg.indexOf("@the_kicker:localhost")).not.toEqual(-1,
                    "Part message doesn't contain kicker's user ID");
                parted = true;
                client._invokeCallback(cb);
            });

            env.mockAppService._trigger("type:m.room.member", {
                content: {
                    membership: "leave"
                },
                user_id: "@the_kicker:localhost",
                state_key: mxUser.id,
                room_id: config._roomid,
                type: "m.room.member"
            }).done(function() {
                expect(parted).toBe(true, "Didn't part");
                done();
            });
        });
    });

    describe("Matrix users on IRC", function() {
        it("should make the AS bot kick the Matrix user from the Matrix room",
        test.coroutine(function*() {
            var userKickedPromise = new Promise(function(resolve, reject) {
                // assert function call when the bot attempts to kick
                var botSdk = env.clientMock._client(config._botUserId);
                botSdk.kick.andCallFake(function(roomId, userId, reason) {
                    expect(roomId).toEqual(config._roomid);
                    expect(userId).toEqual(mxUser.id);
                    expect(reason.indexOf("KickerNick")).not.toEqual(-1,
                        "Reason doesn't contain the kicker's nick");
                    resolve();
                    return Promise.resolve();
                });
            });

            // send the KICK command
            var botCli = yield env.ircMock._findClientAsync(
                config._server, config._botnick
            );
            botCli.emit("kick", config._chan, mxUser.nick, "KickerNick", "Reasons");
            yield userKickedPromise;
        }));
    });

    describe("IRC users on Matrix", function() {

    });
});
