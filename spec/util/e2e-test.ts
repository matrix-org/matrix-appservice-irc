import { AppServiceRegistration } from "matrix-appservice-bridge";
import { BridgeConfig } from "../../src/config/BridgeConfig";
import { Client as PgClient } from "pg";
import { ComplementHomeServer, createHS, destroyHS } from "./homerunner";
import { IrcBridge } from '../../src/bridge/IrcBridge';
import { IrcServer } from "../../src/irc/IrcServer";
import { MatrixClient } from "matrix-bot-sdk";
import { TestIrcServer } from "matrix-org-irc";
import { IrcConnectionPool } from "../../src/pool-service/IrcConnectionPool";
import dns from 'node:dns';

// Needed to make tests work on GitHub actions. Node 17+ defaults
// to IPv6, and the homerunner domain resolves to IPv6, but the
// runtime doesn't actually support IPv6 🤦
dns.setDefaultResultOrder('ipv4first');

const WAIT_EVENT_TIMEOUT = 10000;

const DEFAULT_PORT = parseInt(process.env.IRC_TEST_PORT ?? '6667', 10);
const DEFAULT_ADDRESS = process.env.IRC_TEST_ADDRESS ?? "127.0.0.1";
const IRCBRIDGE_TEST_REDIS_URL = process.env.IRCBRIDGE_TEST_REDIS_URL;

interface Opts {
    matrixLocalparts?: string[];
    ircNicks?: string[];
    timeout?: number;
    config?: Partial<BridgeConfig>,
}

export class IrcBridgeE2ETest {

    private static async createDatabase() {
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
    static async createTestEnv(opts: Opts = {}): Promise<IrcBridgeE2ETest> {
        const { matrixLocalparts, config } = opts;
        const ircTest = new TestIrcServer();
        const [postgresDb, homeserver] = await Promise.all([
            this.createDatabase(),
            createHS(["ircbridge_bot", ...matrixLocalparts || []]),
            ircTest.setUp(opts.ircNicks),
        ]);
        let redisPool: IrcConnectionPool|undefined;

        if (IRCBRIDGE_TEST_REDIS_URL) {
            redisPool = new IrcConnectionPool({
                redisUri: IRCBRIDGE_TEST_REDIS_URL,
                metricsHost: false,
                metricsPort: 7002,
                loggingLevel: 'debug',
            });
        }

        const ircBridge = new IrcBridge({
            homeserver: {
                domain: homeserver.domain,
                url: homeserver.url,
                bindHostname: "0.0.0.0",
                bindPort: homeserver.appserviceConfig.port,
            },
            database: {
                engine: "postgres",
                connectionString: `${process.env.IRCBRIDGE_TEST_PGURL}/${postgresDb}`,
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
            },
            ...(IRCBRIDGE_TEST_REDIS_URL && { connectionPool: {
                redisUrl: IRCBRIDGE_TEST_REDIS_URL,
                persistConnectionsOnShutdown: false,
            }
            }),
            ...config,
        }, AppServiceRegistration.fromObject({
            id: homeserver.id,
            as_token: homeserver.appserviceConfig.asToken,
            hs_token: homeserver.appserviceConfig.hsToken,
            sender_localpart: homeserver.appserviceConfig.senderLocalpart,
            namespaces: {
                users: [{
                    exclusive: true,
                    regex: `@irc_.+:${homeserver.domain}`,
                }],
                // TODO: No support on complement yet:
                // https://github.com/matrix-org/complement/blob/8e341d54bbb4dbbabcea25e6a13b29ead82978e3/internal/docker/builder.go#L413
                aliases: [{
                    exclusive: true,
                    regex: `#irc_.+:${homeserver.domain}`,
                }]
            },
            url: "not-used",
        }), {
            isDBInMemory: false,
        });
        return new IrcBridgeE2ETest(homeserver, ircBridge, postgresDb, ircTest, redisPool)
    }

    private constructor(
        public readonly homeserver: ComplementHomeServer,
        public readonly ircBridge: IrcBridge,
        public readonly postgresDb: string,
        public readonly ircTest: TestIrcServer,
        public readonly pool?: IrcConnectionPool) {
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

    public async setUp(): Promise<void> {
        if (this.pool) {
            await this.pool.start();
        }
        await this.ircBridge.run(null);
    }

    public async tearDown(): Promise<void> {
        await Promise.allSettled([
            this.ircBridge?.kill(),
            this.ircTest.tearDown(),
            this.homeserver?.users.map(c => c.client.stop()),
            this.homeserver && destroyHS(this.homeserver.id),
            this.dropDatabase(),
            this.pool?.close(),
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
