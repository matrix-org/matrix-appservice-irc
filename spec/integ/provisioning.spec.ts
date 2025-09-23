/* eslint-disable @typescript-eslint/no-explicit-any */
import { ErrCode } from "matrix-appservice-bridge";

import { defer } from "../../src/promiseutil";
import envBundle from "../util/env-bundle";
import {IrcErrCode, RequestLinkBody, UnlinkBody} from "../../src/provisioning/Schema";

describe("Provisioning API", function() {

    const { env, config, test } = envBundle() as {
        env: any,
        config: any,
        test: any,
    };

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
            config._server, config._botnick,
            ["#provisionedchannel", "#provisionedchannel1", "#provisionedchannel2", "#somecaps"]
        );

        env.ircMock._autoJoinChannels(
            config._server, mxUser.nick,
            ["#provisionedchannel", "#provisionedchannel1", "#provisionedchannel2", "#somecaps"]
        );

        // Allow receiving of names by bot
        env.ircMock._whenClient(config._server, config._botnick, "names",
            function(_client, chan, cb) {
                const names = new Map();
                names.set(receivingOp.nick, "@"); // is op
                names.set(notOp.nick, ""); // is not op
                cb(chan, names);
            }
        );

        // Allow bot parting a room
        env.ircMock._whenClient(config._server, config._botnick, "part",
            function(client: unknown, chan: string, reason, cb) {
                if (typeof cb === "function") {
                    cb(chan);
                }
            }
        );

        // Keeps track of the bridging state sent to each room.
        // This effectively represents the state of the entire provisioning process and NOT just the link request.
        env.bridgingState = {};

        // Listen for m.room.bridging
        const sdk = env.clientMock._client(config._botUserId);
        sdk.sendStateEvent.and.callFake((roomId, type, key, content) => {
            if (type === "m.room.bridging") {
                const state = env.bridgingState[roomId];

                if (content.status === "pending") {
                    state.isPending.resolve();
                }
                else {
                    if (content.status === "failure") {
                        state.isFailed.resolve();
                    }
                    else if (content.status === "success") {
                        state.isSuccess.resolve();
                    }
                }
            }
            return {};
        });

        await test.initEnv(env);
    };

    const defaultLinkBody: RequestLinkBody & { user_id: string } = {
        remote_room_channel: "#provisionedchannel",
        remote_room_server: "irc.example",
        matrix_room_id: "!foo:bar",
        op_nick: receivingOp.nick,
        key: "",
        user_id: mxUser.id,
    };

    async function link(
        body: unknown,
        waitForState?: "pending" | "success" | "failure",
        shouldOpRespond = true,
    ) {
        const roomId = (body as { matrix_room_id: string }).matrix_room_id;
        env.bridgingState[roomId] = {
            isPending: defer(),
            isFailed: defer(),
            isSuccess: defer(),
        };

        let sentReply = false;
        if (shouldOpRespond) {
            // Listen for message from bot
            env.ircMock._whenClient(config._server, config._botnick, "say", (self: any) => {
                // Say yes back to the bot
                if (sentReply) {
                    return;
                }
                sentReply = true;

                self.emit("message", receivingOp.nick, config._botnick, "yes");
            });
        }

        const res = await env.mockAppService._link(body);

        if (waitForState) {
            const state = env.bridgingState[roomId];
            // Wait until m.room.bridging has been set to the desired state
            if (waitForState === "pending") {
                await state.isPending.promise;
            }
            else if (waitForState === "success") {
                await state.isSuccess.promise;
            }
            else if (waitForState === "failure") {
                await state.isFailed.promise;
            }
        }

        return res;
    }

    const defaultUnlinkBody: UnlinkBody & { user_id: string } = {
        remote_room_channel: "#provisionedchannel",
        remote_room_server: "irc.example",
        matrix_room_id: "!foo:bar",
        user_id: mxUser.id,
    };

    async function unlink(
        body: unknown,
    ) {
        const user_id = (body as { user_id: string }).user_id;
        const sdk = env.clientMock._client(config._botUserId);
        sdk.getRoomState.and.callFake(() => {
            return [{
                type: "m.room.member",
                state_key: user_id,
                user_id: user_id,
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
                        [user_id]: 100
                    },
                    state_default: 100
                }
            }];
        });

        return await env.mockAppService._unlink(body);
    }

    async function listLinks(roomId: string) {
        return await env.mockAppService._listLinks({ roomId });
    }

    describe("room setup", function() {
        beforeEach(doSetup);

        afterEach(async () => {
            await test.afterEach(env);
        });

        describe("link endpoint", function() {
            it("should create a M<--->I link", async () => {
                const res = await link(
                    defaultLinkBody,
                    "pending",
                );
                expect(res.statusCode).toEqual(200);
            });

            it("should create a M<--->I link for a channel that has capital letters in it", async () => {
                const res = await link(
                    {
                        ...defaultLinkBody,
                        remote_room_channel: "#SomeCaps",
                    },
                    "pending",
                );
                expect(res.statusCode).toEqual(200);
            });

            it("should not create a M<--->I link with the same id as one existing", async () => {
                await link(
                    {
                        ...defaultLinkBody,
                    },
                    "success",
                );
                const res = await link(
                    {
                        ...defaultLinkBody,
                    },
                );
                expect(res.statusCode).toEqual(409);
                expect(res._getJSONData().errcode).toEqual(IrcErrCode.ExistingMapping);
            });

            it("should not create a M<--->I link when matrix_room_id is malformed", async () => {
                const res = await link(
                    {
                        ...defaultLinkBody,
                        matrix_room_id: "booooooo",
                    },
                );
                expect(res.statusCode).toEqual(400);
                expect(res._getJSONData().errcode).toEqual(ErrCode.BadValue);
            });

            it("should not create a M<--->I link when remote_room_server is malformed", async () => {
                const res = await link(
                    {
                        ...defaultLinkBody,
                        remote_room_server: "irc./example",
                    },
                );
                expect(res.statusCode).toEqual(400);
                expect(res._getJSONData().errcode).toEqual(ErrCode.BadValue);
            });

            it("should not create a M<--->I link when remote_room_channel is malformed", async () => {
                const res = await link(
                    {
                        ...defaultLinkBody,
                        remote_room_channel: "coffe####e",
                    },
                );
                expect(res.statusCode).toEqual(400);
                expect(res._getJSONData().errcode).toEqual(ErrCode.BadValue);
            });

            // See dynamicChannels.exclude in config file
            it("should not create a M<--->I link when remote_room_channel is excluded by the config", async () => {
                const res = await link(
                    {
                        ...defaultLinkBody,
                        remote_room_channel: "#excluded_channel",
                    },
                );
                expect(res.statusCode).toEqual(404);
                expect(res._getJSONData().errcode).toEqual(IrcErrCode.UnknownChannel);
            });

            it("should not create a M<--->I link when matrix_room_id is not defined", async () => {
                const res = await link(
                    {
                        ...defaultLinkBody,
                        matrix_room_id: null,
                    },
                );
                expect(res.statusCode).toEqual(400);
                expect(res._getJSONData().errcode).toEqual(ErrCode.BadValue);
            });

            it("should not create a M<--->I link when remote_room_server is not defined", async () => {
                const res = await link(
                    {
                        ...defaultLinkBody,
                        remote_room_server: null,
                    },
                );
                expect(res.statusCode).toEqual(400);
                expect(res._getJSONData().errcode).toEqual(ErrCode.BadValue);
            });

            it("should not create a M<--->I link when remote_room_channel is not defined", async () => {
                const res = await link(
                    {
                        ...defaultLinkBody,
                        remote_room_channel: null,
                    },
                );
                expect(res.statusCode).toEqual(400);
                expect(res._getJSONData().errcode).toEqual(ErrCode.BadValue);
            });

            it("should not create a M<--->I link when op_nick is not defined", async () => {
                const res = await link(
                    {
                        ...defaultLinkBody,
                        op_nick: null,
                    },
                );
                expect(res.statusCode).toEqual(400);
                expect(res._getJSONData().errcode).toEqual(ErrCode.BadValue);
            });

            it("should not create a M<--->I link when op_nick is not in the room", async () => {
                const res = await link(
                    {
                        ...defaultLinkBody,
                        op_nick: "somenonexistantop",
                    },
                );
                expect(res.statusCode).toEqual(400);
                expect(res._getJSONData().errcode).toEqual(IrcErrCode.BadOpTarget);
            });

            it("should not create a M<--->I link when op_nick is not an operator, but is in the room", async () => {
                const res = await link(
                    {
                        ...defaultLinkBody,
                        op_nick: notOp.nick,
                    },
                );
                expect(res.statusCode).toEqual(400);
                expect(res._getJSONData().errcode).toEqual(IrcErrCode.BadOpTarget);
            });

            it("should not create a M<--->I link when user does not have enough power in room", async () => {
                const res = await link(
                    {
                        ...defaultLinkBody,
                        user_id: "powerless"
                    },
                );
                expect(res.statusCode).toEqual(403);
                expect(res._getJSONData().errcode).toEqual(IrcErrCode.NotEnoughPower);
            });
        });

        describe("unlink endpoint", function() {
            it("should remove an existing M<--->I link", async () => {
                // Link a room first
                await link(
                    defaultLinkBody,
                    "success",
                );
                // Then unlink it
                const res = await unlink(
                    defaultUnlinkBody,
                );
                expect(res.statusCode).toEqual(200);
            });

            it("should not remove a non-existing M<--->I link", async () => {
                const res = await unlink(
                    {
                        ...defaultUnlinkBody,
                        matrix_room_id: "!idonot:exist",
                    },
                );
                expect(res.statusCode).toEqual(404);
                expect(res._getJSONData().errcode).toEqual(IrcErrCode.UnknownRoom);
            });

            it("should not remove a non-provision M<--->I link", async () => {
                const res = await unlink(
                    {
                        ...defaultUnlinkBody,
                        matrix_room_id: "!foo:bar",
                        remote_room_server : "irc.example",
                        remote_room_channel: "#coffee",
                    },
                );
                expect(res.statusCode).toEqual(404);
                expect(res._getJSONData().errcode).toEqual(IrcErrCode.UnknownRoom);
            });

            it("should not remove a M<--->I link when matrix_room_id is malformed", async () => {
                const res = await unlink(
                    {
                        ...defaultUnlinkBody,
                        matrix_room_id: "booooooo",
                    },
                );
                expect(res.statusCode).toEqual(400);
                expect(res._getJSONData().errcode).toEqual(ErrCode.BadValue);
            });

            it("should not remove a M<--->I link when remote_room_server is malformed", async () => {
                const res = await unlink(
                    {
                        ...defaultUnlinkBody,
                        remote_room_server: "irc./example",
                    },
                );
                expect(res.statusCode).toEqual(400);
                expect(res._getJSONData().errcode).toEqual(ErrCode.BadValue);
            });

            it("should not remove a M<--->I link when remote_room_channel is malformed", async () => {
                const res = await unlink(
                    {
                        ...defaultUnlinkBody,
                        remote_room_channel: "coffe####e",
                    },
                );
                expect(res.statusCode).toEqual(400);
                expect(res._getJSONData().errcode).toEqual(ErrCode.BadValue);
            });

            it("should not remove a M<--->I link when matrix_room_id is not defined", async () => {
                const res = await unlink(
                    {
                        ...defaultUnlinkBody,
                        matrix_room_id: null,
                    },
                );
                expect(res.statusCode).toEqual(400);
                expect(res._getJSONData().errcode).toEqual(ErrCode.BadValue);
            });

            it("should not remove a M<--->I link when remote_room_server is not defined", async () => {
                const res = await unlink(
                    {
                        ...defaultUnlinkBody,
                        remote_room_server: null,
                    },
                );
                expect(res.statusCode).toEqual(400);
                expect(res._getJSONData().errcode).toEqual(ErrCode.BadValue);
            });

            it("should not remove a M<--->I link when remote_room_channel is not defined", async () => {
                const res = await unlink(
                    {
                        ...defaultUnlinkBody,
                        remote_room_channel: null,
                    },
                );
                expect(res.statusCode).toEqual(400);
                expect(res._getJSONData().errcode).toEqual(ErrCode.BadValue);
            });
        });
    });

    describe("with config links existing", function() {
        beforeEach(doSetup);

        afterEach(async () => {
            await test.afterEach(env);
        });

        it("should not create a M<--->I link of the same link id", async () => {
            const res = await link(
                {
                    ...defaultLinkBody,
                    remote_room_channel: "#coffee",
                },
            );
            expect(res.statusCode).toEqual(409);
            expect(res._getJSONData().errcode).toEqual(IrcErrCode.ExistingMapping);
        });
    });

    describe("message sending and joining", function() {
        beforeEach(doSetup);

        afterEach(async () => {
            await test.afterEach(env);
        });

        it("should allow IRC to send messages via the new link", async () => {
            const linkBody = {
                ...defaultLinkBody,
                matrix_room_id: '!foo2:bar',
            };

            const nickForDisplayName = mxUser.nick;

            let gotConnectCall = false;
            env.ircMock._whenClient(linkBody.remote_room_server, nickForDisplayName, "connect",
                function(client, cb) {
                    gotConnectCall = true;
                    client._invokeCallback(cb);
                });

            let gotJoinCall = false;
            env.ircMock._whenClient(
                linkBody.remote_room_server,
                nickForDisplayName,
                "join",
                (client, channel, cb) => {
                    gotJoinCall = true;
                    client._invokeCallback(cb);
                },
            );

            let gotSayCall = false;
            env.ircMock._whenClient(
                linkBody.remote_room_server,
                nickForDisplayName,
                "say",
                (client, channel) => {
                    expect(client.nick).toEqual(nickForDisplayName);
                    expect(client.addr).toEqual(linkBody.remote_room_server);
                    expect(channel).toEqual(linkBody.remote_room_channel);
                    gotSayCall = true;
                },
            );

            // Create a link
            await link(
                linkBody,
                "success",
            );

            // Send a message
            await env.mockAppService._trigger(
                "type:m.room.message",
                {
                    content: {
                        body: "A message",
                        msgtype: "m.text"
                    },
                    user_id: mxUser.id,
                    room_id: linkBody.matrix_room_id,
                    type: "m.room.message"
                },
            );

            expect(gotConnectCall).toBe(true);
            expect(gotJoinCall).toBe(true);
            expect(gotSayCall).toBe(true);
        });

        it("should not allow IRC to send messages following unlink", async () => {
            const linkBody = {
                ...defaultLinkBody,
                matrix_room_id: '!foo2:bar',
            };

            const nickForDisplayName = mxUser.nick;

            let countSays = 0;
            env.ircMock._whenClient(
                linkBody.remote_room_server,
                nickForDisplayName,
                "say",
                (client, channel) => {
                    expect(client.nick).toEqual(nickForDisplayName);
                    expect(client.addr).toEqual(linkBody.remote_room_server);
                    expect(channel).toEqual(linkBody.remote_room_channel);
                    countSays++;
                },
            );

            // Create a link
            await link(
                linkBody,
                "success",
            );

            // Send a message
            await env.mockAppService._trigger(
                "type:m.room.message",
                {
                    content: {
                        body: "A message",
                        msgtype: "m.text"
                    },
                    user_id: mxUser.id,
                    room_id: linkBody.matrix_room_id,
                    type: "m.room.message"
                },
            );

            // Remove the link
            await unlink({
                ...defaultUnlinkBody,
                matrix_room_id: '!foo2:bar',
            });

            // Send a message that should not get passed through
            await env.mockAppService._trigger(
                "type:m.room.message",
                {
                    content: {
                        body: "This message should not be sent",
                        msgtype: "m.text"
                    },
                    user_id: mxUser.id,
                    room_id: '!foo2:bar',
                    type: "m.room.message"
                },
            );

            expect(countSays).toEqual(1);
        })
    });

    describe("listings endpoint", () => {
        beforeEach(doSetup);

        afterEach(async () => test.afterEach(env));

        it("should return an empty list when no mappings have been provisioned", async () => {
            const res = await listLinks("!someroom:somedomain");
            expect(res.statusCode).toEqual(200);
            expect(res._getJSONData()).toEqual([]);
        });

        it("should return a list with a mapping that has been previously provisioned", async () => {
            const linkBody = defaultLinkBody;

            // Create a link
            await link(
                linkBody,
                "success",
            );

            const res = await listLinks(linkBody.matrix_room_id);
            expect(res.statusCode).toEqual(200);
            expect(res._getJSONData()).toEqual([
                {
                    matrix_room_id : linkBody.matrix_room_id,
                    remote_room_server : linkBody.remote_room_server,
                    remote_room_channel : linkBody.remote_room_channel,
                },
            ]);
        });

        it("should return a list of mappings that have been previously provisioned", async () => {
            const linkBody1 = {
                ...defaultLinkBody,
                remote_room_channel: '#provisionedchannel1',
            };

            const linkBody2 = {
                ...defaultLinkBody,
                remote_room_channel: '#provisionedchannel2',
            };

            // Create links
            await link(
                linkBody1,
                "success",
            );
            await link(
                linkBody2,
                "success",
            );

            const res = await listLinks(linkBody1.matrix_room_id);
            expect(res.statusCode).toEqual(200);
            expect(res._getJSONData()).toEqual([
                {
                    matrix_room_id : linkBody1.matrix_room_id,
                    remote_room_server : linkBody1.remote_room_server,
                    remote_room_channel : linkBody1.remote_room_channel,
                },
                {
                    matrix_room_id : linkBody2.matrix_room_id,
                    remote_room_server : linkBody2.remote_room_server,
                    remote_room_channel : linkBody2.remote_room_channel,
                },
            ]);
        });

        it("should return a list of mappings that have been previously provisioned," +
            " but not those that have been unlinked", async () => {
            const linkBody1 = {
                ...defaultLinkBody,
                remote_room_channel: '#provisionedchannel1',
            };

            const linkBody2 = {
                ...defaultLinkBody,
                remote_room_channel: '#provisionedchannel2',
            };

            // Create links
            await link(
                linkBody1,
                "success",
            );
            await link(
                linkBody2,
                "success",
            );

            // Unlink one of them
            await unlink(
                {
                    ...defaultUnlinkBody,
                    remote_room_channel: '#provisionedchannel1',
                },
            );

            const res = await listLinks(linkBody1.matrix_room_id);
            expect(res.statusCode).toEqual(200);
            expect(res._getJSONData()).toEqual([
                {
                    matrix_room_id : linkBody2.matrix_room_id,
                    remote_room_server : linkBody2.remote_room_server,
                    remote_room_channel : linkBody2.remote_room_channel,
                },
            ]);
        });
    });

    describe("should set m.room.bridging=success", function() {
        beforeEach(doSetup);

        afterEach(() => {
            return test.afterEach(env);
        });

        it("when the link is successful", async () => {
            await link(
                defaultLinkBody,
                "success",
            );
        });
    });

    describe("should set m.room.bridging=failed", function() {
        beforeEach(doSetup);

        afterEach(() => {
            return test.afterEach(env);
        });

        it("when the op did not authorise after a certain timeout", async () => {
            await link(
                defaultLinkBody,
                "failure",
                false,
            );
        });
    });
});
