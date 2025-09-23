/*
 * Contains integration tests for all Startup-initiated events.
 */

const envBundle = require("../util/env-bundle");
const { Ipv6Generator } = require("../../lib/irc/Ipv6Generator");
const { IrcClientConfig } = require("../../lib/models/IrcClientConfig");
const { IrcServer } = require("../../lib/irc/IrcServer");

describe("Ipv6Generator", () => {
    const {env, roomMapping, test} = envBundle();
    let generator;
    let store;
    const server = new IrcServer("domain", IrcServer.DEFAULT_CONFIG, "example.com");

    beforeEach(async () => {
        await test.beforeEach(env);
        env.ircMock._whenClient(roomMapping.server, roomMapping.botNick, "connect", (client, fn) => {
            fn();
        });
        await test.initEnv(env);
        store = env.ircBridge.getStore();
        generator = new Ipv6Generator(store);
    });

    afterEach(async () => test.afterEach(env));


    it("should generate an IPv6 address", async function() {
        const address = await generator.generate(
            '2001:0db8:85a3::', new IrcClientConfig('@foo:example.com', 'irc.example.com'), server
        );
        expect(address).toEqual('2001:0db8:85a3::1');
        const newConfig = await store.getIrcClientConfig('@foo:example.com', 'irc.example.com');
        expect(newConfig.userId).toEqual('@foo:example.com');
        expect(newConfig.domain).toEqual('irc.example.com');
        expect(newConfig.config.ipv6).toEqual('2001:0db8:85a3::1');
    });

    it("should NOT generate an IPv6 address for an existing config", async function() {
        const config = new IrcClientConfig('@foo:example.com', 'irc.example.com', {
            ipv6: '2001:0db8:85a3::1a16'
        });
        await store.storeIrcClientConfig(config);
        const address = await generator.generate(
            '2001:0db8:85a3::', new IrcClientConfig('@foo:example.com', 'irc.example.com',
                {ipv6: '2001:0db8:85a3::1a16'}
            ), server);
        expect(address).toEqual('2001:0db8:85a3::1a16');
        const fetchedConfig = await store.getIrcClientConfig('@foo:example.com', 'irc.example.com');
        expect(fetchedConfig.userId).toEqual('@foo:example.com');
        expect(fetchedConfig.domain).toEqual('irc.example.com');
        expect(fetchedConfig.config.ipv6).toEqual('2001:0db8:85a3::1a16');
    });

    it("should queue and generate multiple IPv6 addresses", async function() {
        const promises = [];
        for (let i = 0; i < 10; i++) {
            promises.push(
                generator.generate(
                    '2001:0db8:85a3::',
                    new IrcClientConfig(`@foo${i}:example.com`, 'irc.example.com'),
                    server,
                )
            );
        }
        await Promise.all(promises);
        for (let i = 0; i < 10; i++) {
            const newConfig = await store.getIrcClientConfig(`@foo${i}:example.com`, 'irc.example.com');
            expect(newConfig.userId).toEqual(`@foo${i}:example.com`);
            expect(newConfig.domain).toEqual('irc.example.com');
            expect(newConfig.config.ipv6).toEqual(`2001:0db8:85a3::${(i+1).toString(16)}`);
        }
    });


    it("should ensure IPv6 addresses are only unique across one network", async function() {
        const serverOne = new IrcServer("irc-server-one", {
            ...IrcServer.DEFAULT_CONFIG,
        }, "example.com");
        const serverTwo = new IrcServer("irc-server-two", {
            ...IrcServer.DEFAULT_CONFIG,
        }, "example.com");
        expect(
            await generator.generate(
            '2001:0db8:85a3::',
            new IrcClientConfig('@foo:example.com', 'irc.example.com'),
            serverOne
        )).toEqual('2001:0db8:85a3::1');
        expect(
            await generator.generate(
            '2001:0db8:85a3::',
            new IrcClientConfig('@foo:on-another-wavelength.com', 'irc.example.com'),
            serverTwo
        )).toEqual('2001:0db8:85a3::1');
    });

    it("should generate an IPv6 address for a user within a block", async function() {
        const serverWithBlocks = new IrcServer("domain", {
            ...IrcServer.DEFAULT_CONFIG,
            ircClients: {
                ipv6: {
                    blocks: [
                        {
                            homeserver: 'on-another-wavelength.com',
                            startFrom: '100',
                        },
                        {
                            homeserver: 'even-further-out.com',
                            startFrom: '200',
                        },
                        {
                            homeserver: 'over-provisioned.com',
                            startFrom: 'f000:0000',
                        }
                    ]
                }
            }
        }, "example.com");
        expect(
            await generator.generate(
            '2001:0db8:85a3::',
            new IrcClientConfig('@foo:example.com', 'irc.example.com'),
            serverWithBlocks
        )).toEqual('2001:0db8:85a3::1');
        expect(
            await generator.generate(
            '2001:0db8:85a3::',
            new IrcClientConfig('@foo:on-another-wavelength.com', 'irc.example.com'),
            serverWithBlocks
        )).toEqual('2001:0db8:85a3::101');
        expect(
            await generator.generate(
            '2001:0db8:85a3::',
            new IrcClientConfig('@foo:even-further-out.com', 'irc.example.com'),
            serverWithBlocks
        )).toEqual('2001:0db8:85a3::201');
        expect(
            await generator.generate(
            '2001:0db8:85a3::',
            new IrcClientConfig('@foo:over-provisioned.com', 'irc.example.com'),
            serverWithBlocks
        )).toEqual('2001:0db8:85a3::f000:0001');
    });
});
