import { IrcServer as IrcServerTest } from "matrix-org-irc/spec/util/irc-server";
import { ComplementHomeServer, createHS, destroyHS } from "./homerunner";
import { describe, beforeEach, afterEach, jest } from '@jest/globals';
import { IrcBridge } from '../../src/bridge/IrcBridge';
import { AppServiceRegistration } from "matrix-appservice";
import { IrcServer } from "../../src/irc/IrcServer";
import { mkdtemp, rm } from "fs/promises";
import path from "path";

const DEFAULT_E2E_TIMEOUT = parseInt(process.env.IRC_TEST_TIMEOUT ?? '30000', 10);

// TODO: Expose these
const DEFAULT_PORT = parseInt(process.env.IRC_TEST_PORT ?? '6667', 10);
const DEFAULT_ADDRESS = process.env.IRC_TEST_ADDRESS ?? "127.0.0.1";

interface Opts {
    clients: string[];
    timeout?: number;
}

export class IrcBridgeE2ETest extends IrcServerTest {

    /**
     * Test wrapper that automatically provisions an IRC server and Matrix server
     * @param name The test name
     * @param fn The inner function
     * @returns A jest describe function.
     */
    static describe(name: string, fn: (env: () => IrcBridgeE2ETest) => void, opts?: Opts) {
        return describe(name, () => {
            jest.setTimeout(opts?.timeout ?? DEFAULT_E2E_TIMEOUT);
            let env: IrcBridgeE2ETest;
            beforeEach(async () => {
                env = new IrcBridgeE2ETest();
                await env.setUp(opts?.clients);
            });
            afterEach(async () => {
                await env.tearDown();
            });
            fn(() => env);
        });
    }

    private homeserver?: ComplementHomeServer;
    public ircBridge?: IrcBridge;
    /**
     * TODO: Postgresql
     */
    private dbPath?: string;

    public async setUp(clients?: string[], matrixLocalparts?: string[]): Promise<void> {
        // Set up Matrix homeserver - Need to register the bridge bot.
        this.homeserver = await createHS(["ircbridge_bot", ...matrixLocalparts || []]);
        // Set up IRC server
        super.setUp(clients);
        // Set up an IRC bridge.
        this.dbPath = path.join(await mkdtemp('ircbridge-'), 'test.db');

        this.ircBridge = new IrcBridge({
            homeserver: {
                domain: this.homeserver.domain,
                url: this.homeserver.url,
                bindHostname: "0.0.0.0",
                bindPort: this.homeserver.appserviceConfig.port,
            },
            database: {
                connectionString: this.dbPath,
                engine: "nedb",
            },
            ircService: {
                servers: {
                    localhost: {
                        ...IrcServer.DEFAULT_CONFIG,
                        port: DEFAULT_PORT,
                        additionalAddresses: [DEFAULT_ADDRESS],
                        onlyAdditionalAddresses: true,
                    }
                },
                provisioning: {
                    enabled: false,
                    requestTimeoutSeconds: 0,
                },
                logging: {
                    level: "debug",
                    toConsole: true,
                    maxFiles: 0,
                    verbose: false,
                    timestamp: true,
                },
                ident: {
                    enabled: false,
                    address: "",
                    port: 0,
                },
                debugApi: {
                    enabled: false,
                    port: 0,
                }
            }
        }, AppServiceRegistration.fromObject({
            id: this.homeserver.id,
            as_token: this.homeserver.appserviceConfig.asToken,
            hs_token: this.homeserver.appserviceConfig.hsToken,
            sender_localpart: this.homeserver.appserviceConfig.senderLocalpart,
            namespaces: {
                users: [{
                    exclusive: true,
                    regex: `@irc_.+:${this.homeserver.domain}`,
                }],
                // TODO: No support on complement yet:
                // https://github.com/matrix-org/complement/blob/8e341d54bbb4dbbabcea25e6a13b29ead82978e3/internal/docker/builder.go#L413
                rooms: [{
                    exclusive: true,
                    regex: `#irc_.+:${this.homeserver.domain}`,
                }]
            },
            url: "not-used",
        }));
        await this.ircBridge.run(null);
    }

    public async tearDown(): Promise<void> {
        await Promise.all([
            this.dbPath && rm(this.dbPath, { recursive: true}),
            this.ircBridge?.kill(),
            super.tearDown(),
            this.homeserver?.id && destroyHS(this.homeserver.id),
        ]);
    }
}
