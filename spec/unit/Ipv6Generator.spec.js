const { Ipv6Generator } = require("../../lib/irc/Ipv6Generator.js");
const { IrcClientConfig } = require("../../lib/models/IrcClientConfig.js");

describe("IPV6 Generator", function() {
    let datastore;
    let storeIpv6Counter;
    let ircClientConfigs;
    beforeEach(() => {
        storeIpv6Counter = 0;
        ircClientConfigs = { };
        datastore = {
            getIpv6Counter: async () => storeIpv6Counter,
            setIpv6Counter: async (counter) => {storeIpv6Counter = counter},
            getIrcClientConfig: async (sender, domain) => ircClientConfigs[sender+domain],
            storeIrcClientConfig: async (config) => {ircClientConfigs[config.userId+config.domain] = config},
        };
    });

    it("should generate an IPv6 address", async function() {
        const generator = new Ipv6Generator(datastore);
        const address = await generator.generate(
            '2001:0db8:85a3::', new IrcClientConfig('@foo:example.com', 'irc.example.com')
        );
        expect(address).toEqual('2001:0db8:85a3::1');
        const newConfig = ircClientConfigs['@foo:example.comirc.example.com'];
        expect(newConfig.userId).toEqual('@foo:example.com');
        expect(newConfig.domain).toEqual('irc.example.com');
        expect(newConfig.config.ipv6).toEqual('2001:0db8:85a3::1');
    });

    it("should NOT generate an IPv6 address for an existing config", async function() {
        const generator = new Ipv6Generator(datastore);
        const config = new IrcClientConfig('@foo:example.com', 'irc.example.com', {
            ipv6: '2001:0db8:85a3::1a16'
        });
        ircClientConfigs['@foo:example.comirc.example.com'] = config;
        const address = await generator.generate(
            '2001:0db8:85a3::', new IrcClientConfig('@foo:example.com', 'irc.example.com',
                {ipv6: '2001:0db8:85a3::1a16'}
            ));
        expect(address).toEqual('2001:0db8:85a3::1a16');
        const fetchedConfig = ircClientConfigs['@foo:example.comirc.example.com'];
        expect(fetchedConfig.userId).toEqual('@foo:example.com');
        expect(fetchedConfig.domain).toEqual('irc.example.com');
        expect(fetchedConfig.config.ipv6).toEqual('2001:0db8:85a3::1a16');
    });

    it("should queue and generate multiple IPv6 addresses", async function() {
        const generator = new Ipv6Generator(datastore);
        const promises = [];
        for (let i = 0; i < 10; i++) {
            promises.push(
                generator.generate('2001:0db8:85a3::', new IrcClientConfig(`@foo${i}:example.com`, 'irc.example.com'))
            );
        }
        await Promise.all(promises);
        for (let i = 0; i < 10; i++) {
            const newConfig = ircClientConfigs[`@foo${i}:example.comirc.example.com`];
            expect(newConfig.userId).toEqual(`@foo${i}:example.com`);
            expect(newConfig.domain).toEqual('irc.example.com');
            expect(newConfig.config.ipv6).toEqual(`2001:0db8:85a3::${(i+1).toString(16)}`);
        }
    });
});
