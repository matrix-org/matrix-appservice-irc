const promiseutil = require("../../lib/promiseutil.js");
const envBundle = require("../util/env-bundle");

describe("Provisioning API", function() {

    const {env, config, test} = envBundle();

    const mxUser = {
        id: "@flibble:wibble",
        nick: "M-flibble"
    };

    const ircUser = {
        nick: "bob",
        localpart: config._server + "_bob",
        id: `@${config._server}_bob:${config.homeserver.domain}`
    };

    const receivingOp = {
        nick: "oprah"
    };

    const notOp = {
        nick: "notoprah"
    };

    const doSetup = async () => {
        await test.beforeEach(env);

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

        // Bot now joins the provisioned channel to check for ops
        env.ircMock._autoJoinChannels(
            config._server, config._botnick, ['#provisionedchannel', '#somecaps']
        );

        env.ircMock._autoJoinChannels(
            config._server, mxUser.nick, ['#provisionedchannel', '#somecaps']
        );

        // Allow receiving of names by bot
        env.ircMock._whenClient(config._server, config._botnick, "names",
            function(_client, chan, cb) {
                const names = new Map();
                names.set(receivingOp.nick, '@'); // is op
                names.set(notOp.nick, ''); // is not op
                cb(chan, names);
            }
        );

        // Allow bot parting a room
        env.ircMock._whenClient(config._server, config._botnick, "part",
            function(client, chan, reason, cb) {
                if (typeof cb === 'function') {
                    cb(chan);
                }
            }
        );

        // Use these to determine what bridging state has been sent to the room
        //  these effectively represent the status of the entire provisioning process
        //  and NOT just the sending of the link request to the op
        env.isPending = promiseutil.defer();
        env.isFailed = promiseutil.defer();
        env.isSuccess = promiseutil.defer();

        // Listen for m.room.bridging
        const sdk = env.clientMock._client(config._botUserId);
        sdk.sendStateEvent.and.callFake((roomId, type, key, content) => {
            if (type === "m.room.bridging") {
                if (content.status === "pending") {
                    env.isPending.resolve();
                }
                else {
                    if (content.status === "failure") {
                        env.isFailed.resolve();
                    }
                    else if (content.status === "success") {
                        env.isSuccess.resolve();
                    }
                }
            }
            return {};
        });

        await test.initEnv(env);
    };

    // Create a async function to test certain API parameters.
    //  parameters {object} - the API parameters
    //  shouldSucceed {boolean} - true if the request should succeed (not the overall link process)
    //  link {boolean} - true if this is a link request (false if unlink)
    //  doLinkBeforeUnlink {boolean} - Optional. Default true. true if the link action
    //      before an unlink should be done.
    //  opAuth {boolean} - Optional. Default true. true if the op will send reply 'yes'
    //      to the link request.
    const mockLinkCR = async (parameters, shouldSucceed, link, doLinkBeforeUnlink, opAuth) => {
        if (!env.isPending) {
            throw new Error('Expected env.isPending to be defined!');
        }

        if (doLinkBeforeUnlink === undefined) {
            doLinkBeforeUnlink = true;
        }
        if (opAuth === undefined) {
            opAuth = true;
        }

        let json = jasmine.createSpy("json(obj)")
        .and.callFake(function(obj) {
            console.log('JSON ' + JSON.stringify(obj))
        });
        let status = jasmine.createSpy("status(num)")
        .and.callFake(function(number) {
            console.log(`HTTP STATUS ${number}`)
        });

        // Defaults
        if (parameters.matrix_room_id === undefined) {
            parameters.matrix_room_id = "!foo:bar";
        }
        if (parameters.remote_room_server === undefined) {
            parameters.remote_room_server = "irc.example";
        }
        if (parameters.remote_room_channel === undefined) {
            parameters.remote_room_channel = "#provisionedchannel";
        }
        if (parameters.op_nick === undefined) {
            parameters.op_nick = receivingOp.nick;
        }
        if (parameters.user_id === undefined) {
            parameters.user_id = mxUser.id;
        }

        for (let p in parameters) {
            if (parameters[p] === null) {
                parameters[p] = undefined;
            }
        }

        let sentReply = false;

        // Listen for message from bot
        if (opAuth) {
            env.ircMock._whenClient(config._server, config._botnick, 'say', (self, message) => {
                // Say yes back to the bot
                if (sentReply) {
                    return;
                }
                sentReply = true;

                self.emit("message", receivingOp.nick, config._botnick, 'yes');
            });
        }

        // When the _link promise resolves...
        const resolve = async () => {
            if (shouldSucceed) {
                // success is indicated with empty object
                expect(json).toHaveBeenCalledWith({});

                return;
            }
            // but it should not have resolved
            throw new Error('Expected to fail');
        };

        // When the _link fails
        const reject = async (err) => {
            console.error(err.stack);
            // but it should have succeeded
            if (shouldSucceed) {
                throw new Error('Expected to succeeded');
            }
            // and it should have failed
            expect(err).toBeDefined();
            expect(status).toHaveBeenCalledWith(500);
            expect(json).toHaveBeenCalled();
            // Make sure the first call to JSON has error defined
            expect(json.calls.argsFor(0)[0].error).toBeDefined();
        };


        try {
            // Unlink needs an existing link to remove, so add one first
            if (doLinkBeforeUnlink) {
                await env.mockAppService._link(
                    parameters, status, json
                );

                // Wait until m.room.bridging has been set accordingly
                await env.isPending.promise;
            }

            // Only link is required, resolve early
            if (link) {
                return resolve();
            }

            // If a link was made
            if (doLinkBeforeUnlink) {
                // Wait for the link to be success or failure
                if (shouldSucceed) {
                    await env.isSuccess.promise;
                }
                else {
                    await env.isFailed.promise;
                }
            }

            const sdk = env.clientMock._client(config._botUserId);
            sdk.getRoomState.and.callFake((roomId) => {
                return [{
                    type: "m.room.member",
                    state_key: parameters.user_id,
                    user_id: parameters.user_id,
                    content: {
                        membership: "join"
                    }
                }, {
                    type: "m.room.power_levels",
                    state_key: "",
                    user_id: "@someone:here",
                    content:{
                        users_default: 0,
                        users: {
                            [parameters.user_id]: 100
                        },
                        state_default: 100
                    }
                }];
            });

            await env.mockAppService._unlink(
                parameters, status, json
            );
            return resolve();
        }
        catch (err) {
            return reject(err);
        }
    }

    const mockLink = () => {
        // args to pass to mockLinkCR
        let args = Array.from(arguments);

        return async () => {
            await mockLinkCR.apply(mockLinkCR, args);
        };
    }

    describe("room setup", function() {
        beforeEach(doSetup);

        afterEach(async () => {
            await test.afterEach(env);
        });

        describe("link endpoint", function() {

            // Hello future person. Please do NOT write your tests like this. It is
            // very difficult to follow what is going on here and this actually introduced
            // a bug where all the tests ran in parallel. For the time being these tests will
            // be left in this function soup mess because we know the tests work, but please
            // write your tests clearly.

            it("should create a M<--->I link", async () => {
                await mockLink({}, true, true);
            });

            it("should create a M<--->I link for a channel that has capital letters in it", async () => {
                await mockLink({remote_room_channel: '#SomeCaps'}, true, true);
            });

            it("should not create a M<--->I link with the same id as one existing", async () => {
                await mockLink({
                    matrix_room_id : '!foo:bar',
                    remote_room_server : 'irc.example',
                    remote_room_channel : '#coffee'}, false, true);
            });

            it("should not create a M<--->I link when room_id is malformed", async () => {
                await mockLink({matrix_room_id : '!fooooooo'}, false, true);
            });

            it("should not create a M<--->I link when remote_room_server is malformed", async () => {
                await mockLink({remote_room_server : 'irc./example'}, false, true);
            });

            it("should not create a M<--->I link when remote_room_channel is malformed", async () => {
                await mockLink({remote_room_channel : 'coffe####e'}, false, true);
            });

            // See dynamicChannels.exclude in config file
            it("should not create a M<--->I link when remote_room_channel is excluded by the " +
                "config", async () => {
                await mockLink({remote_room_channel : '#excluded_channel'}, false, true);
            });

            it("should not create a M<--->I link when matrix_room_id is not defined", async () => {
                await mockLink({matrix_room_id : null}, false, true);
            });

            it("should not create a M<--->I link when remote_room_server is not defined", async () => {
                await mockLink({remote_room_server : null}, false, true);
            });

            it("should not create a M<--->I link when remote_room_channel is not defined", async () => {
                await mockLink({remote_room_channel : null}, false, true);
            });

            it("should not create a M<--->I link when op_nick is not defined", async () => {
                await mockLink({op_nick : null}, false, true);
            });

            it("should not create a M<--->I link when op_nick is not in the room", async () => {
                await mockLink({op_nick : 'somenonexistantop'}, false, true);
            });

            it("should not create a M<--->I link when op_nick is not an operator, but is in the " +
                "room", async () => {
                await mockLink({op_nick : notOp.nick}, false, true);
            });

            it("should not create a M<--->I link when user does not have enough power in room", async () => {
                await mockLink({user_id: 'powerless'}, false, true);
            });
        });

        describe("unlink endpoint", function() {
            it("should remove an existing M<--->I link", async () => {
                await mockLink({}, true, false)
            });

            it("should not remove a non-existing M<--->I link", async () => {
                await mockLink({matrix_room_id : '!idonot:exist'}, false, false, false)
            });

            it("should not remove a non-provision M<--->I link", async () => {
                await mockLink({
                    matrix_room_id : '!foo:bar',
                    remote_room_server : 'irc.example',
                    remote_room_channel : '#coffee'}, false, false)
                });

            it("should not remove a M<--->I link when room_id is malformed", async () => {
                await mockLink({matrix_room_id : '!fooooooooo'}, false, false)
            });

            it("should not remove a M<--->I link when remote_room_server is malformed", async () => {
                await mockLink({remote_room_server : 'irc./example'}, false, false)
            });

            it("should not remove a M<--->I link when remote_room_channel is malformed", async () => {
                await mockLink({remote_room_channel : 'coffe####e'}, false, false)
            });

            it("should not remove a M<--->I link when matrix_room_id is " +
                "not defined", async () => {
                await mockLink({matrix_room_id : null}, false, true)
            });

            it("should not remove a M<--->I link when remote_room_server is " +
                "not defined", async () => {
                await mockLink({remote_room_server : null}, false, true)
            });

            it("should not remove a M<--->I link when remote_room_channel is " +
                "not defined", async () => {
                await mockLink({remote_room_channel : null}, false, true)
            });
        });
    });

    describe("with config links existing", function() {
        beforeEach(async () => {
            config.ircService
                .servers[config._server]
                .mappings['#provisionedchannel'] = ['!foo:bar'];

            // The following is copy of doSetup
            //  It is a copy because otherwise there is not other way
            //  to alter config before running.

            await test.beforeEach(env);

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

            // Bot now joins the provisioned channel to check for ops
            env.ircMock._autoJoinChannels(
                config._server, config._botnick, '#provisionedchannel'
            );

            // Allow receiving of names by bot
            env.ircMock._whenClient(config._server, config._botnick, "names",
                function(_client, chan, cb) {
                    const names = new Map();
                    names.set(receivingOp.nick, '@'); // is op
                    names.set(notOp.nick, ''); // is not op
                    cb(chan, names);
                }
            );

            // Allow bot parting a room
            env.ircMock._whenClient(config._server, config._botnick, "part",
                function(client, chan, reason, cb) {
                    if (typeof cb === 'function') {
                        cb(chan);
                    }
                }
            );

            // Use these to determine what bridging state has been sent to the room
            env.isPending = promiseutil.defer();
            env.isFailed = promiseutil.defer();
            env.isSuccess = promiseutil.defer();

            // Listen for m.room.bridging filure
            const sdk = env.clientMock._client(config._botUserId);
            sdk.sendStateEvent.and.callFake((roomId, type, key, content) => {
                // Status of m.room.bridging is a success
                if (type === "m.room.bridging") {
                    if (content.status === "pending") {
                        env.isPending.resolve();
                    }
                    else {
                        if (content.status === "failure") {
                            env.isFailed.resolve();
                        }
                        else if (content.status === "success") {
                            env.isSuccess.resolve();
                        }
                    }
                }
                return Promise.resolve({});
            });

            // do the init
            await test.initEnv(env);
        });

        afterEach(async () => {
            await test.afterEach(env);
        });

        it("should not create a M<--->I link of the same link id", async () => {
            await mockLink({}, false, true)
        });
    });

    describe("message sending and joining", function() {
        beforeEach(async () => {
            config.ircService.servers[config._server].mappings = {};
            await test.beforeEach(env);

            // Ignore bot connecting
            env.ircMock._autoConnectNetworks(
                config._server, config._botnick, config._server
            );

            env.ircMock._autoJoinChannels(
                config._server, config._botnick, config._chan
            );

            // Bot now joins the provisioned channel to check for ops
            env.ircMock._autoJoinChannels(
                config._server, config._botnick, '#provisionedchannel'
            );

            // Allow receiving of names by bot
            env.ircMock._whenClient(config._server, config._botnick, "names",
                function(_client, chan, cb) {
                    const names = new Map();
                    names.set(receivingOp.nick, '@'); // is op
                    names.set(notOp.nick, ''); // is not op
                    cb(chan, names);
                }
            );

            // Allow bot parting a room
            env.ircMock._whenClient(config._server, config._botnick, "part",
                function(client, chan, reason, cb) {
                    if (typeof cb === 'function') {
                        cb(chan);
                    }
                }
            );

            // do the init
            await test.initEnv(env);
        });

        afterEach(async () => {
            await test.afterEach(env);
        });

        it("should allow IRC to send messages via the new link", async () => {
            let json = jasmine.createSpy("json(obj)");
            let status = jasmine.createSpy("status(num)");

            let parameters = {
                matrix_room_id : "!foo:bar",
                remote_room_server : "irc.example",
                remote_room_channel : "#provisionedchannel",
                op_nick : receivingOp.nick,
                user_id : mxUser.id
            };

            let roomMapping = {
                roomId : parameters.matrix_room_id,
                server : parameters.remote_room_server,
                channel : parameters.remote_room_channel
            };

            let nickForDisplayName = mxUser.nick;

            let gotConnectCall = false;
            env.ircMock._whenClient(roomMapping.server, nickForDisplayName, "connect",
            function(client, cb) {
                gotConnectCall = true;
                client._invokeCallback(cb);
            });

            let gotJoinCall = false;
            env.ircMock._whenClient(roomMapping.server, nickForDisplayName, "join",
            function(client, channel, cb) {
                gotJoinCall = true;
                client._invokeCallback(cb);
            });

            let gotSayCall = false;
            env.ircMock._whenClient(roomMapping.server, nickForDisplayName, "say",
            function(client, channel, text) {
                expect(client.nick).toEqual(nickForDisplayName);
                expect(client.addr).toEqual(roomMapping.server);
                expect(channel).toEqual(roomMapping.channel);
                gotSayCall = true;
            });

            let isLinked = promiseutil.defer();

            let replySent = false;

            env.ircMock._whenClient(config._server, config._botnick, 'say', (self) => {
                if (replySent) {
                    return;
                }
                replySent = true;
                // Listen for m.room.bridging success
                const sdk = env.clientMock._client(config._botUserId);
                sdk.sendStateEvent.and.callFake((roomId, type, keu, content) => {
                    // Status of m.room.bridging is a success
                    if (type === "m.room.bridging" && content.status === "success") {
                        isLinked.resolve();
                    }
                    return Promise.resolve({});
                });

                // Say yes back to the bot
                self.emit("message", receivingOp.nick, config._botnick, 'yes');
            });

            // Create a link
            await env.mockAppService._link(
                parameters, status, json
            );

            await isLinked.promise;

            // Send a message
            await env.mockAppService._trigger(
                "type:m.room.message",
                {content: {
                    body: "A message",
                    msgtype: "m.text"
                },
                user_id: mxUser.id,
                room_id: roomMapping.roomId,
                type: "m.room.message"
            });

            expect(gotConnectCall).toBe(
                true, nickForDisplayName + " failed to connect to IRC."
            );
            expect(gotJoinCall).toBe(
                true, nickForDisplayName + " failed to join IRC channel."
            );
            expect(gotSayCall).toBe(true, "Didn't get say");
        });

        it("should not allow IRC to send messages following unlink", async () => {
            const json = jasmine.createSpy("json(obj)");
            const status = jasmine.createSpy("status(num)");

            const parameters = {
                matrix_room_id : "!foo:bar",
                remote_room_server : "irc.example",
                remote_room_channel : "#provisionedchannel",
                op_nick : receivingOp.nick,
                user_id : mxUser.id
            };

            const roomMapping = {
                roomId : parameters.matrix_room_id,
                server : parameters.remote_room_server,
                channel : parameters.remote_room_channel
            };

            const nickForDisplayName = mxUser.nick;

            let gotConnectCall = false;
            env.ircMock._whenClient(roomMapping.server, nickForDisplayName, "connect", (client, cb) => {
                gotConnectCall = true;
                client._invokeCallback(cb);
            });

            let gotJoinCall = false;
            env.ircMock._whenClient(roomMapping.server, nickForDisplayName, "join", (client, channel, cb) => {
                gotJoinCall = true;
                client._invokeCallback(cb);
            });

            let countSays = 0;
            env.ircMock._whenClient(roomMapping.server, nickForDisplayName, "say", (client, channel, text) => {
                expect(client.nick).toEqual(nickForDisplayName);
                expect(client.addr).toEqual(roomMapping.server);
                expect(channel).toEqual(roomMapping.channel);
                countSays++;
            });

            let isLinked = promiseutil.defer();

            let replySent = false;

            env.ircMock._whenClient(config._server, config._botnick, 'say', (self) => {
                if (replySent) {
                    return;
                }
                replySent = true;
                // Listen for m.room.bridging success
                const sdk = env.clientMock._client(config._botUserId);
                sdk.sendStateEvent.and.callFake((roomId, type, key, content) => {
                    // Status of m.room.bridging is a success
                    if (type === "m.room.bridging" && content.status === "success") {
                        isLinked.resolve();
                    }
                    return {};
                });

                // Say yes back to the bot
                self.emit("message", receivingOp.nick, config._botnick, 'yes');
            });

            // Create the link
            await env.mockAppService._link(parameters, status, json);

            await isLinked.promise;

            // Send a message
            await env.mockAppService._trigger(
                "type:m.room.message",
                {content: {
                    body: "First message",
                    msgtype: "m.text"
                },
                user_id: mxUser.id,
                room_id: roomMapping.roomId,
                type: "m.room.message"
            });

            const sdk = env.clientMock._client(config._botUserId);
            sdk.getRoomState.and.callFake((roomId) => {
                return Promise.resolve([{
                    type: "m.room.member",
                    state_key: parameters.user_id,
                    user_id: parameters.user_id,
                    content: {
                        membership: "join"
                    }
                }, {
                    type: "m.room.power_levels",
                    state_key: "",
                    user_id: "@someone:here",
                    content:{
                        users_default: 100,
                        state_default: 100
                    }
                }]);
            });

            //Remove the link
            await env.mockAppService._unlink(parameters, status, json);

            // Send a message that should not get passed through
            await env.mockAppService._trigger(
                "type:m.room.message",
                {content: {
                    body: "This message should not be sent",
                    msgtype: "m.text"
                },
                user_id: mxUser.id,
                room_id: roomMapping.roomId,
                type: "m.room.message"
            });

            expect(gotConnectCall).toBe(
                true, nickForDisplayName + " failed to connect to IRC."
            );
            expect(gotJoinCall).toBe(
                true, nickForDisplayName + " failed to join IRC channel."
            );
            expect(countSays).toBe(
                1, "Should have only sent one message"
            );
        })
    });

    describe("listings endpoint", () => {
        beforeEach(async () => {
            await test.beforeEach(env);

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

            // Bot now joins the provisioned channel to check for ops
            env.ircMock._autoJoinChannels(
                config._server, config._botnick,
                ['#provisionedchannel',
                '#provisionedchannel1',
                '#provisionedchannel2']
            );

            env.ircMock._autoJoinChannels(
                config._server, mxUser.nick,
                ['#provisionedchannel',
                '#provisionedchannel1',
                '#provisionedchannel2']
            );

            // Allow receiving of names by bot
            env.ircMock._whenClient(config._server, config._botnick, "names",
                function(_client, chan, cb) {
                    const names = new Map();
                    names.set(receivingOp.nick, '@'); // is op
                    names.set(notOp.nick, ''); // is not op
                    cb(chan, names);
                }
            );

            // Allow bot parting a room
            env.ircMock._whenClient(config._server, config._botnick, "part",
                function(client, chan, reason, cb) {
                    if (typeof cb === 'function') {
                        cb(chan);
                    }
                }
            );

            // do the init
            await test.initEnv(env);
        });

        afterEach(async () => test.afterEach(env));

        it("should return an empty list when no mappings have been provisioned", async () => {
            let json = jasmine.createSpy("json(obj)");
            let status = jasmine.createSpy("status(num)");

            await env.mockAppService
                ._listLinks({roomId : '!someroom:somedomain'}, status, json);

            expect(json).toHaveBeenCalledWith([]);
        });

        it("should return a list with a mapping that has been previously provisioned", async () => {
            let json = jasmine.createSpy("json(obj)");
            let status = jasmine.createSpy("status(num)");

            let expectedListings = [{
                matrix_room_id : "!foo:bar",
                remote_room_server : "irc.example",
                remote_room_channel : "#provisionedchannel"}];

            let parameters = {
                matrix_room_id : "!foo:bar",
                remote_room_server : "irc.example",
                remote_room_channel : "#provisionedchannel",
                op_nick : receivingOp.nick,
                user_id : mxUser.id
            };

            let isLinked = promiseutil.defer();
            let replySent = false;

            env.ircMock._whenClient(config._server, config._botnick, 'say', (self) => {
                if (replySent) {
                    return;
                }
                replySent = true;
                // Listen for m.room.bridging success
                const sdk = env.clientMock._client(config._botUserId);
                sdk.sendStateEvent.and.callFake((roomId, type, key, content) => {
                    // Status of m.room.bridging is a success
                    if (type === "m.room.bridging" && content.status === "success") {
                        isLinked.resolve();
                    }
                    return Promise.resolve({});
                });
                // Say yes back to the bot
                self.emit("message", receivingOp.nick, config._botnick, 'yes');
            });

            await env.mockAppService._link(parameters, status, json);
            await isLinked.promise;

            await env.mockAppService
                ._listLinks({roomId : parameters.matrix_room_id}, status, json);

            expect(json).toHaveBeenCalledWith(expectedListings);
        });

        it("should return a list of mappings that have been previously provisioned", async () => {
            const json = jasmine.createSpy("json(obj)");
            const status = jasmine.createSpy("status(num)");

            const roomId = "!foo:bar";
            const parameters = [{
                matrix_room_id : roomId,
                remote_room_server : "irc.example",
                remote_room_channel : "#provisionedchannel1",
                op_nick : receivingOp.nick,
                user_id : mxUser.id
            }, {
                matrix_room_id : roomId,
                remote_room_server : "irc.example",
                remote_room_channel : "#provisionedchannel2",
                op_nick : receivingOp.nick,
                user_id : mxUser.id
            }];

            const listings = parameters.map((mapping) => {
                return {
                    matrix_room_id: mapping.matrix_room_id,
                    remote_room_server: mapping.remote_room_server,
                    remote_room_channel: mapping.remote_room_channel
                };
            });

            const isLinked = [promiseutil.defer(), promiseutil.defer()];
            let i = 0;

            let ignoreNextBotMessage = false;

            env.ircMock._whenClient(config._server, config._botnick, 'say', (self) => {
                if (ignoreNextBotMessage) {
                    ignoreNextBotMessage = false;
                    return;
                }
                // Listen for m.room.bridging success
                const sdk = env.clientMock._client(config._botUserId);
                sdk.sendStateEvent.and.callFake((stateRoomId, type, key, content) => {
                    // Status of m.room.bridging is a success
                    if (type === "m.room.bridging" && content.status === "success") {
                        isLinked[i++].resolve();
                    }
                    return Promise.resolve({});
                });

                // Ignore the response from the bot, which will be "Thanks", or similar
                ignoreNextBotMessage = true;
                // Say yes back to the bot
                self.emit("message", receivingOp.nick, config._botnick, 'yes');
            });

            await env.mockAppService._link(parameters[0], status, json);
            await isLinked[0].promise;
            await env.mockAppService._link(parameters[1], status, json);
            await Promise.all( isLinked.map( d => d.promise ) );

            await env.mockAppService._listLinks({roomId : roomId}, status, json);

            expect(json).toHaveBeenCalledWith(listings);
        });

        it("should return a list of mappings that have been previously provisioned," +
            " but not those that have been unlinked", async () => {
            let json = jasmine.createSpy("json(obj)");
            let status = jasmine.createSpy("status(num)");

            let listingsjson = jasmine.createSpy("json(obj)");

            let roomId = "!foo:bar";
            let parameters = [{
                matrix_room_id : roomId,
                remote_room_server : "irc.example",
                remote_room_channel : "#provisionedchannel1",
                op_nick : receivingOp.nick,
                user_id : mxUser.id
            }, {
                matrix_room_id : roomId,
                remote_room_server : "irc.example",
                remote_room_channel : "#provisionedchannel2",
                op_nick : receivingOp.nick,
                user_id : mxUser.id
            }];

            let listings = parameters.map((mapping) => {
                return {
                    matrix_room_id: mapping.matrix_room_id,
                    remote_room_server: mapping.remote_room_server,
                    remote_room_channel: mapping.remote_room_channel
                };
            });

            let isLinked = [promiseutil.defer(), promiseutil.defer()];
            let i = 0;

            let ignoreNextBotMessage = false;
            env.ircMock._whenClient(config._server, config._botnick, 'say', (self) => {
                if (ignoreNextBotMessage) {
                    ignoreNextBotMessage = false;
                    return;
                }
                // Listen for m.room.bridging success
                const sdk = env.clientMock._client(config._botUserId);
                sdk.sendStateEvent.and.callFake((stateRoomId, type, key, content) => {
                    // Status of m.room.bridging is a success
                    if (type === "m.room.bridging" && content.status === "success") {
                        isLinked[i++].resolve();
                    }
                    return Promise.resolve({});
                });

                // Ignore the response from the bot, which will be "Thanks", or similar
                ignoreNextBotMessage = true;
                // Say yes back to the bot
                self.emit("message", receivingOp.nick, config._botnick, 'yes');
            });

            await env.mockAppService._link(parameters[0], status, json);
            await isLinked[0].promise;
            await env.mockAppService._link(parameters[1], status, json);
            await Promise.all(isLinked.map((d)=>{return d.promise;}));


            const sdk = env.clientMock._client(config._botUserId);
            sdk.getRoomState.and.callFake((rid) => {
                return Promise.resolve([{
                    type: "m.room.member",
                    state_key: mxUser.id,
                    user_id: mxUser.id,
                    content: {
                        membership: "join"
                    }
                }, {
                    type: "m.room.power_levels",
                    state_key: "",
                    user_id: "@someone:here",
                    content:{
                        users_default: 100,
                        state_default: 100
                    }
                }]);
            });

            await env.mockAppService._unlink(parameters[0], status, json);
            await env.mockAppService._listLinks({roomId : roomId}, status, listingsjson);

            expect(listingsjson).toHaveBeenCalledWith([listings[1]]);
        });
    });

    describe("should set m.room.bridging=success", function() {
        beforeEach(doSetup);

        afterEach(() => {
            return test.afterEach(env);
        });

        it("when the link is successful", async () => {
            await mockLinkCR({}, true, true, true, true);
            await env.isPending.promise;
            await env.isSuccess.promise;
        });
    });

    describe("should set m.room.bridging=failed", function() {
        beforeEach(doSetup);

        afterEach(() => {
            return test.afterEach(env);
        });

        it("when the op did not authorise after a certain timeout", async () => {
            // shouldSucceed refers to the linkRequest only, not the overall success
            //  so whilst the request is expected to succeed, the bridging status is
            //  expected to be failure (because the op will not respond)
            let shouldSucceed = true;
            let opShouldRespond = false;
            await mockLinkCR({}, shouldSucceed, true, true, opShouldRespond);
            await env.isPending.promise;
            await env.isFailed.promise;
        });
    });
});
