import { Redis } from 'ioredis';
import { Logger, LogLevel } from 'matrix-appservice-bridge';
import { createConnection, Socket } from 'net';
import tls from 'tls';
import { REDIS_IRC_POOL_COMMAND_IN_STREAM_LAST_READ, OutCommandType,
    REDIS_IRC_POOL_COMMAND_OUT_STREAM, IrcConnectionPoolCommandIn,
    ConnectionCreateArgs, InCommandType, CommandError,
    REDIS_IRC_POOL_HEARTBEAT_KEY,
    REDIS_IRC_POOL_VERSION_KEY,
    REDIS_IRC_POOL_COMMAND_IN_STREAM,
    REDIS_IRC_POOL_CONNECTIONS,
    ClientId,
    OutCommandPayload,
    IrcConnectionPoolCommandOut,
    REDIS_IRC_CLIENT_STATE_KEY,
    HEARTBEAT_EVERY_MS,
    PROTOCOL_VERSION
} from './types';
import { parseMessage } from 'matrix-org-irc';
import { collectDefaultMetrics, register, Gauge } from 'prom-client';
import { createServer, Server } from 'http';

const log = new Logger('IrcConnectionPool');
const TIME_TO_WAIT_BEFORE_PONG = 10000;
const STREAM_HISTORY_MAXLEN = 50;

const Config = {
    redisUri: process.env.REDIS_URL ?? 'redis://localhost:6379',
    metricsHost: (process.env.METRICS_HOST ?? false) as string|false,
    metricsPort: parseInt(process.env.METRICS_PORT ?? '7002'),
    loggingLevel: (process.env.LOGGING_LEVEL ?? 'info') as LogLevel,
}

const connectionsGauge = new Gauge({
    help: 'The number of connections being held by the pool',
    name: 'irc_pool_connections'
});

export class IrcConnectionPool {
    private readonly redis: Redis;
    /**
     * Track all the connections expecting a pong response.
     */
    private readonly connectionPongTimeouts = new Map<ClientId, NodeJS.Timeout>();
    private readonly cmdReader: Redis;
    private readonly connections = new Map<ClientId, Socket>();

    private commandStreamId = "$";
    private metricsServer?: Server;
    private shouldRun = true;

    constructor(private readonly config: typeof Config) {
        this.redis = new Redis(config.redisUri);
        this.cmdReader = new Redis(config.redisUri);
    }

    private updateLastRead(lastRead: string) {
        this.commandStreamId = lastRead;
        this.redis.set(REDIS_IRC_POOL_COMMAND_IN_STREAM_LAST_READ, lastRead).catch((ex) => {
            log.warn(`Unable to update last-read for command.in`, ex);
        })
    }

    private async sendCommandOut<T extends OutCommandType>(type: T, payload: OutCommandPayload[T]) {
        await this.redis.xadd(REDIS_IRC_POOL_COMMAND_OUT_STREAM, "*", type, JSON.stringify({
            info: payload,
            origin_ts: Date.now(),
        } as IrcConnectionPoolCommandOut<OutCommandType>)).catch((ex) => {
            log.warn(`Unable to send command out`, ex);
        });
        log.debug(`Sent command out ${type}`, payload);
    }

    private async createConnectionForOpts(opts: ConnectionCreateArgs): Promise<Socket> {
        let socket: Socket;
        if (opts.secure) {
            let secureOpts: tls.ConnectionOptions = {
                ...opts,
                rejectUnauthorized: !(opts.selfSigned || opts.certExpired),
            }

            if (typeof opts.secure === 'object') {
                // copy "secure" opts to options passed to connect()
                secureOpts = {
                    ...secureOpts,
                    ...opts.secure,
                };
            }

            socket = await new Promise((resolve, reject) => {
                // Taken from https://github.com/matrix-org/node-irc/blob/0764733af7c324ee24f8c2a3c26fe9d1614be344/src/irc.ts#L1231
                const sock = tls.connect(secureOpts, () => {
                    if (sock.authorized) {
                        resolve(sock);
                    }
                    let valid = false;
                    const err = sock.authorizationError.toString();
                    switch (err) {
                        case 'DEPTH_ZERO_SELF_SIGNED_CERT':
                        case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
                        case 'SELF_SIGNED_CERT_IN_CHAIN':
                            if (opts.selfSigned) {
                                valid = true;
                            }
                            break;
                        case 'CERT_HAS_EXPIRED':
                            if (!opts.certExpired) {
                                valid = true;
                            }
                            break;
                        default:
                            // Fail on other errors
                    }
                    if (!valid) {
                        sock.destroy(sock.authorizationError);
                        throw Error(`Unable to create socket: ${err}`);
                    }
                    resolve(sock);
                });
                sock.once('error', (error) => {
                    reject(error);
                })
            });
        }
        return new Promise((resolve, reject) => {
            socket = createConnection(opts, () => resolve(socket)) as Socket;
            socket.once('error', (error) => {
                reject(error);
            });
        });
    }

    private async handleConnectCommand(payload: IrcConnectionPoolCommandIn<InCommandType.Connect>) {
        const opts = payload.info;
        const { clientId } = payload.info;
        let connection: Socket;

        try {
            connection = await this.createConnectionForOpts(opts);
        }
        catch (ex) {
            log.error(`Failed to connect to ${opts.host}:${opts.port}`, ex);
            return this.sendCommandOut(OutCommandType.Error, {
                clientId,
                error: ex.message,
            });
        }

        log.info(
            `Connected ${clientId} to ${connection.remoteAddress}:${connection.remotePort}` +
            `(via ${connection.localAddress}:${connection.localPort})`
        );
        this.redis.hset(REDIS_IRC_POOL_CONNECTIONS, clientId, `${connection.localAddress}:${connection.localPort}`);
        this.connections.set(clientId, connection);
        connectionsGauge.set(this.connections.size);

        connection.on('error', (ex) => {
            log.error(`Failed to connect to ${opts.host}:${opts.port}`, ex);
            this.sendCommandOut(OutCommandType.Error, {
                clientId,
                error: ex.message,
            });
        });

        connection.on('data', (data) => {
            // Read/write are special - We just send the full buffer
            if (!Buffer.isBuffer(data)) {
                // *Just* in case.
                data = Buffer.from(data);
            }

            // We need to respond to PINGs with a PONG even if the bridge is down to prevent our connections
            // from rapidly exploding. To do this, do a noddy check for PING and then a thorough check for
            // the message content. If the IRC bridge fails to respond to the PING, we send it for it.
            // If we send two PONGs by mistake, that's fine. We just need to be sure we sent at least one!
            if (data.includes('PING')) {
                const msg = parseMessage(data.toString('utf-8'), false);
                if (msg.command === 'PING') {
                    log.warn(`Sending PONG for ${clientId}, since the bridge didn't respond fast enough.`);
                    this.connectionPongTimeouts.set(clientId, setTimeout(() => {
                        connection.write('PONG ' + msg.args[0] + "\r\n");
                    }, TIME_TO_WAIT_BEFORE_PONG));
                }
            }

            this.redis.xaddBuffer(REDIS_IRC_POOL_COMMAND_OUT_STREAM, "*", clientId, data).catch((ex) => {
                log.warn(`Unable to send raw read out`, ex);
            })
        });
        connection.on('close', () => {
            log.debug(`Closing connection for ${clientId}`);
            this.redis.hdel(REDIS_IRC_POOL_CONNECTIONS, clientId);
            this.redis.hdel(REDIS_IRC_CLIENT_STATE_KEY, payload.info.clientId);
            this.connections.delete(clientId);
            connectionsGauge.set(this.connections.size);
            this.sendCommandOut(OutCommandType.Disconnected, {
                clientId,
            });
        });

        return this.sendCommandOut(OutCommandType.Connected, {
            localIp: connection.localAddress ?? "unknown",
            localPort: connection.localPort ?? -1,
            clientId,
        });
    }

    private async handleDestroyCommand(payload: IrcConnectionPoolCommandIn<InCommandType.Destroy>) {
        const connection = this.connections.get(payload.info.clientId);
        if (!connection) {
            log.warn(`Got destroy but no connection matching ${payload.info.clientId} was found`);
            return;
        }
        connection.destroy();
    }

    private async handleEndCommand(payload: IrcConnectionPoolCommandIn<InCommandType.End>) {
        const connection = this.connections.get(payload.info.clientId);
        if (!connection) {
            log.warn(`Got end but no connection matching ${payload.info.clientId} was found`);
            return;
        }
        connection.end();
    }

    private async handleSetTimeoutCommand(payload: IrcConnectionPoolCommandIn<InCommandType.SetTimeout>) {
        const connection = this.connections.get(payload.info.clientId);
        if (!connection) {
            log.warn(`Got set-timeout but no connection matching ${payload.info.clientId} was found`);
            return;
        }
        connection.setTimeout(payload.info.timeout);
    }

    private async handleWriteCommand(payload: IrcConnectionPoolCommandIn<InCommandType.Write>) {
        const connection = this.connections.get(payload.info.clientId);

        // This is a *very* noddy check to see if the IRC bridge has sent back a pong.
        // It's not really important if this is correct, but it's key *this* process
        // sends back a PONG if nothing has been written to the connection.
        if (payload.info.data.startsWith('PONG')) {
            clearTimeout(this.connectionPongTimeouts.get(payload.info.clientId));
        }

        if (!connection) {
            log.warn(`Got write but no connection matching ${payload.info.clientId} was found`);
            return;
        }
        connection.write(payload.info.data);
        log.debug(`${payload.info.clientId} wrote ${payload.info.data.length} bytes`);
    }

    private async handleCommand<T extends InCommandType>(type: T, payload: IrcConnectionPoolCommandIn<T>) {
        // TODO: Ignore stale commands
        log.debug(`Got incoming command ${type} from ${payload.info.clientId}`);
        switch (type) {
            case InCommandType.Connect:
                // Spawn a connection
                await this.handleConnectCommand(payload as IrcConnectionPoolCommandIn<InCommandType.Connect>);
                break;
            case InCommandType.Destroy:
                // Spawn a connection
                await this.handleDestroyCommand(payload as IrcConnectionPoolCommandIn<InCommandType.Destroy>);
                break;
            case InCommandType.End:
                // Spawn a connection
                await this.handleEndCommand(payload as IrcConnectionPoolCommandIn<InCommandType.End>);
                break;
            case InCommandType.SetTimeout:
                // Spawn a connection
                await this.handleSetTimeoutCommand(payload as IrcConnectionPoolCommandIn<InCommandType.SetTimeout>);
                break;
            case InCommandType.Write:
                // Spawn a connection
                await this.handleWriteCommand(payload as IrcConnectionPoolCommandIn<InCommandType.Write>);
                break;
            case InCommandType.ConnectionPing:
                await this.handleInternalPing(payload as IrcConnectionPoolCommandIn<InCommandType.ConnectionPing>);
                break;
            case InCommandType.Ping:
                await this.sendCommandOut(OutCommandType.Pong, { });
                break;
            default:
                throw new CommandError("Type not understood", type);
        }
    }

    public async handleInternalPing({ info }: IrcConnectionPoolCommandIn<InCommandType.ConnectionPing>) {
        const { clientId } = info;
        const conn = this.connections.get(clientId);
        if (!conn) {
            return this.sendCommandOut(OutCommandType.NotConnected, { clientId });
        }
        if (conn.readableEnded) {
            // Erp, somehow we missed this
            this.connections.delete(clientId);
            connectionsGauge.set(this.connections.size);
            await this.sendCommandOut(OutCommandType.Disconnected, { clientId });
            return this.sendCommandOut(OutCommandType.NotConnected, { clientId });
        }
        // Otherwise, it happy.
        return this.sendCommandOut(OutCommandType.Connected, { clientId });
    }

    public sendHeartbeat() {
        log.debug(`Sending heartbeat`);
        return this.redis.set(REDIS_IRC_POOL_HEARTBEAT_KEY, Date.now());
    }

    public async main() {
        Logger.configure({ console: this.config.loggingLevel });
        collectDefaultMetrics();

        // Load metrics
        if (this.config.metricsHost) {
            this.metricsServer = createServer((request, response) => {
                if (request.url !== "/metrics") {
                    response.statusCode = 404;
                    response.write('Not found.');
                    response.end();
                    return;
                }
                if (request.method !== "GET") {
                    response.statusCode = 405;
                    response.write('Method not supported. Use GET.');
                    response.end();
                    return;
                }
                register.metrics().then(metrics => {
                    response.write(metrics);
                    response.end();
                }).catch(ex => {
                    log.error(`Could not read metrics`, ex);
                    response.statusCode = 500;
                    response.write('Failed to get metrics');
                    response.end();
                });
            }).listen(this.config.metricsPort, this.config.metricsHost, 10);
            await new Promise((resolve, reject) => {
                this.metricsServer?.once('listening', resolve);
                this.metricsServer?.once('error', reject);
            });
            log.info(`Listening for metrics on ${this.config.metricsHost}:${this.config.metricsPort}`);
        }

        // Register yourself with redis and set the current protocol version
        await this.redis.set(REDIS_IRC_POOL_VERSION_KEY, PROTOCOL_VERSION);
        await this.sendHeartbeat();

        // Fetch the last read index.
        this.commandStreamId = await this.redis.get(REDIS_IRC_POOL_COMMAND_IN_STREAM_LAST_READ) || "$";

        // Warn of any existing connections. TODO: This assumes one service process.
        await this.redis.del(REDIS_IRC_POOL_CONNECTIONS);
        await this.redis.del(REDIS_IRC_CLIENT_STATE_KEY);
        await this.redis.del(REDIS_IRC_POOL_COMMAND_IN_STREAM);
        await this.redis.del(REDIS_IRC_POOL_COMMAND_OUT_STREAM);

        setInterval(() => {
            this.sendHeartbeat().catch((ex) => {
                log.warn(`Failed to send heartbeat`, ex);
            });
            this.redis.xtrim(REDIS_IRC_POOL_COMMAND_IN_STREAM, "MAXLEN", "~", STREAM_HISTORY_MAXLEN).then(trimCount => {
                log.debug(`Trimmed ${trimCount} commands from the IN stream`);
            }).catch((ex) => {
                log.warn(`Failed to trim commands from the IN stream`, ex);
            });
            this.redis.xtrim(
                REDIS_IRC_POOL_COMMAND_OUT_STREAM, "MAXLEN", "~", STREAM_HISTORY_MAXLEN).then(trimCount => {
                log.debug(`Trimmed ${trimCount} commands from the OUT stream`);
            }).catch((ex) => {
                log.warn(`Failed to trim commands from the OUT stream`, ex);
            });
        }, HEARTBEAT_EVERY_MS);


        log.info(`Listening for new commands`);
        while (this.shouldRun) {
            const newCmd = await this.cmdReader.xread(
                "BLOCK", 0, "STREAMS", REDIS_IRC_POOL_COMMAND_IN_STREAM, this.commandStreamId);
            if (newCmd === null) {
                // Unexpected, this is blocking.
                continue;
            }
            // This is a list of keys, containing a list of commands, hence needing to deeply extract the values.
            const [msgId, [cmdType, payload]] = newCmd[0][1][0];

            const commandType = cmdType as InCommandType;

            // If we crash, we don't want to get stuck on this msg.
            await this.updateLastRead(msgId);
            const commandData = JSON.parse(payload) as IrcConnectionPoolCommandIn<InCommandType>;
            setImmediate(
                () => this.handleCommand(commandType, commandData)
                    .catch(ex => log.warn(`Failed to handle msg ${msgId} (${commandType}, ${payload})`, ex)
                    ),
            );
        }
        log.info(`Finished loop`);
    }

    public async close() {
        this.shouldRun = false;
        await this.sendCommandOut(OutCommandType.PoolClosing, { });
        this.connections.forEach((socket) => {
            socket.write('QUIT :Process terminating\r\n');
            socket.end();
        });
        // TODO: Test doesn't like this.
        //await this.redis.quit();
        await this.cmdReader.quit();
    }

}

if (require.main === module) {
    const pool = new IrcConnectionPool(Config);
    process.on("SIGINT", () => {
        log.info("SIGTERM recieved, killing pool");
        pool.close().then(() => {
            log.info("Completed cleanup, exiting");
            process.exit(0);
        }).catch(err => {
            log.warn("Error while closing pool, exiting anyway", err);
            process.exit(1);
        })
    });

    pool.main().catch(ex => {
        log.error('Pool process encountered an error', ex);
    });
}
