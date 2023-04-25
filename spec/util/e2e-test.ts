import { IrcServer as IrcServerTest, TestClient } from "matrix-org-irc/spec/util/irc-server";
import { ComplementHomeServer, createHS, destroyHS } from "./homerunner";
import { describe, beforeEach, afterEach, jest } from '@jest/globals';
import { IrcBridge } from '../../src/bridge/IrcBridge';
import { AppServiceRegistration } from "matrix-appservice-bridge";
import { IrcServer } from "../../src/irc/IrcServer";
import dns from 'node:dns';
import { MatrixClient } from "matrix-bot-sdk";
import { Client as PgClient } from "pg";

// Needed to make tests work on GitHub actions. Node 17+ defaults
// to IPv6, and the homerunner domain resolves to IPv6, but the
// runtime doesn't actually support IPv6 🤦
dns.setDefaultResultOrder('ipv4first');


const DEFAULT_E2E_TIMEOUT = parseInt(process.env.IRC_TEST_TIMEOUT ?? '90000', 10);
const WAIT_EVENT_TIMEOUT = 10000;

const DEFAULT_PORT = parseInt(process.env.IRC_TEST_PORT ?? '6667', 10);
const DEFAULT_ADDRESS = process.env.IRC_TEST_ADDRESS ?? "127.0.0.1";

interface Opts {
    matrixLocalparts?: string[];
    clients?: string[];
    timeout?: number;
}

interface DescribeEnv {
    homeserver: ComplementHomeServer;
    ircBridge: IrcBridge;
    clients: TestClient[];
}

export class IrcBridgeE2ETest extends IrcServerTest {

    /**
     * Test wrapper that automatically provisions an IRC server and Matrix server
     * @param name The test name
     * @param fn The inner function
     * @returns A jest describe function.
     */
    static describeTest(name: string, fn: (env: () => DescribeEnv) => void, opts?: Opts) {
        return describe(name, () => {
            jest.setTimeout(opts?.timeout ?? DEFAULT_E2E_TIMEOUT);
            let env: IrcBridgeE2ETest;
            beforeEach(async () => {
                env = new IrcBridgeE2ETest();
                await env.setUp(opts?.clients, opts?.matrixLocalparts);
            });
            afterEach(async () => {
                await env.tearDown();
            });
            fn(() => {
                if (!env.homeserver) {
                    throw Error('Homeserver not defined');
                }
                if (!env.ircBridge) {
                    throw Error('ircBridge not defined');
                }
                return { homeserver: env.homeserver, ircBridge: env.ircBridge, clients: env.clients }
            });
        });
    }

    public homeserver?: ComplementHomeServer;
    public ircBridge?: IrcBridge;
    public postgresDb?: string;

    private async createDatabase() {
        const pgClient = new PgClient(`${process.env.IRCBRIDGE_TEST_PGURL}/postgres`);
        try {
            await pgClient.connect();
            const postgresDb = `${process.env.IRCBRIDGE_TEST_PGDB}_${process.hrtime().join("_")}`;
            await pgClient.query(`CREATE DATABASE ${postgresDb}`);
            return postgresDb;
        }
        finally {
            await pgClient.end();
        }
    }

    private async dropDatabase() {
        if (!this.postgresDb) {
            // Database was never set up.
            return;
        }
        const pgClient = new PgClient(`${process.env.IRCBRIDGE_TEST_PGURL}/postgres`);
        await pgClient.connect();
        await pgClient.query(`DROP DATABASE ${this.postgresDb}`);
        await pgClient.end();
    }

    public async setUp(clients?: string[], matrixLocalparts?: string[]): Promise<void> {
        // Setup PostgreSQL.
        this.postgresDb = await this.createDatabase();
        const [postgresDb, homeserver] = await Promise.all([
            this.createDatabase(),
            createHS(["ircbridge_bot", ...matrixLocalparts || []]),
            super.setUp(clients),
        ]);
        this.homeserver = homeserver;
        this.postgresDb = postgresDb;

        this.ircBridge = new IrcBridge({
            homeserver: {
                domain: this.homeserver.domain,
                url: this.homeserver.url,
                bindHostname: "0.0.0.0",
                bindPort: this.homeserver.appserviceConfig.port,
            },
            database: {
                engine: "postgres",
                connectionString: `${process.env.IRCBRIDGE_TEST_PGURL}/${this.postgresDb}`,
            },
            ircService: {
                servers: {
                    localhost: {
                        ...IrcServer.DEFAULT_CONFIG,
                        port: DEFAULT_PORT,
                        additionalAddresses: [DEFAULT_ADDRESS],
                        onlyAdditionalAddresses: true,
                        matrixClients: {
                            userTemplate: "@irc_$NICK",
                            displayName: "$NICK",
                            joinAttempts: 3,
                        },
                        dynamicChannels: {
                            enabled: true,
                            createAlias: true,
                            published: true,
                            joinRule: "public",
                            federate: true,
                            aliasTemplate: "#irc_$SERVER_$CHANNEL",
                        },
                        membershipLists: {
                            enabled: true,
                            floodDelayMs: 100,
                            global: {
                                ircToMatrix: {
                                    incremental: true,
                                    initial: true,
                                    requireMatrixJoined: false,
                                },
                                matrixToIrc: {
                                    incremental: true,
                                    initial: true,
                                }
                            }
                        }
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
                aliases: [{
                    exclusive: true,
                    regex: `#irc_.+:${this.homeserver.domain}`,
                }]
            },
            url: "not-used",
        }));
        console.log('Starting bridge');
        await this.ircBridge.run(null);
    }

    public async tearDown(): Promise<void> {
        await Promise.allSettled([
            this.ircBridge?.kill(),
            super.tearDown(),
            this.homeserver?.users.map(c => c.client.stop()),
            this.homeserver && destroyHS(this.homeserver.id),
            this.dropDatabase(),
        ]);
    }
}

export class E2ETestMatrixClient extends MatrixClient {

    public async waitForRoomEvent(
        opts: {eventType: string, sender: string, roomId?: string, stateKey?: string}
    ): Promise<{roomId: string, data: unknown}> {
        const {eventType, sender, roomId, stateKey} = opts;
        return this.waitForEvent('room.event', (eventRoomId: string, eventData: {
            sender: string, type: string, state_key?: string, content: unknown
        }) => {
            console.info(`Got ${eventRoomId}`, eventData);
            if (eventData.sender !== sender) {
                return undefined;
            }
            if (eventData.type !== eventType) {
                return undefined;
            }
            if (roomId && eventRoomId !== roomId) {
                return undefined;
            }
            if (stateKey !== undefined && eventData.state_key !== stateKey) {
                return undefined;
            }
            return {roomId: eventRoomId, data: eventData};
        }, `Timed out waiting for ${eventType} from ${sender} in ${roomId || "any room"}`)
    }

    public async waitForRoomInvite(
        opts: {sender: string, roomId?: string}
    ): Promise<{roomId: string, data: unknown}> {
        const {sender, roomId} = opts;
        return this.waitForEvent('room.invite', (eventRoomId: string, eventData: {
            sender: string
        }) => {
            const inviteSender = eventData.sender;
            console.info(`Got invite to ${eventRoomId} from ${inviteSender}`);
            if (eventData.sender !== sender) {
                return undefined;
            }
            if (roomId && eventRoomId !== roomId) {
                return undefined;
            }
            return {roomId: eventRoomId, data: eventData};
        }, `Timed out waiting for invite to ${roomId || "any room"} from ${sender}`)
    }

    public async waitForEvent<T>(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        emitterType: string, filterFn: (...args: any[]) => T|undefined, timeoutMsg: string)
    : Promise<T> {
        return new Promise((resolve, reject) => {
            // eslint-disable-next-line prefer-const
            let timer: NodeJS.Timeout;
            const fn = (...args: unknown[]) => {
                const data = filterFn(...args);
                if (data) {
                    clearTimeout(timer);
                    resolve(data);
                }
            };
            timer = setTimeout(() => {
                this.removeListener(emitterType, fn);
                reject(new Error(timeoutMsg));
            }, WAIT_EVENT_TIMEOUT);
            this.on(emitterType, fn)
        });
    }
}
