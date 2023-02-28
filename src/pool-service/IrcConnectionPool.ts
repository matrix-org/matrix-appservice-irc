import { Redis } from 'ioredis';
import { Logger } from 'matrix-appservice-bridge';
import { createConnection, Socket } from 'net';
import { REDIS_IRC_POOL_COMMAND_IN_STREAM_LAST_READ, OutCommandType,
    REDIS_IRC_POOL_COMMAND_OUT_STREAM, IrcConnectionPoolCommandIn,
    ConnectionCreateArgs, InCommandType, CommandError, REDIS_IRC_POOL_KEY,
    REDIS_IRC_POOL_COMMAND_IN_STREAM,
    REDIS_IRC_POOL_CONNECTIONS,
    DestoryArgs,
    EndArgs,
    SetTimeoutArgs,
    ClientId,
    WriteArgs,
    OutCommandPayload,
    IrcConnectionPoolCommandOut,
    REDIS_IRC_CLIENT_STATE_KEY} from './types';

// TODO: Cap streams.

const log = new Logger('IrcConnectionPool');


export class IrcConnectionPool {
    private readonly redis: Redis;
    private readonly serviceName: string;
    private commandsInLastRead = "$";

    private connections = new Map<ClientId, Socket>();
    cmdReader: Redis;

    constructor() {
        this.redis = new Redis({
            host: "localhost",
        });
        this.cmdReader = new Redis({
            host: "localhost",
        });
        // TODO: Need something unique across restarts.
        this.serviceName = `pool.${process.pid}`;
    }

    private updateLastRead(lastRead: string) {
        this.commandsInLastRead = lastRead;
        this.redis.set(REDIS_IRC_POOL_COMMAND_IN_STREAM_LAST_READ + this.serviceName, lastRead).catch((ex) => {
            log.warn(`Unable to update last-read for command.in`, ex);
        })
    }

    private async sendCommandOut(type: OutCommandType, payload: OutCommandPayload) {
        this.redis.xadd(REDIS_IRC_POOL_COMMAND_OUT_STREAM, "*", type, JSON.stringify({
            info: payload,
            origin_ts: Date.now(),
        } as IrcConnectionPoolCommandOut)).catch((ex) => {
            log.warn(`Unable to send command out`, ex);
        });
        log.debug(`Sent command out ${type}`, payload);
    }

    private async handleConnectCommand(payload: IrcConnectionPoolCommandIn<ConnectionCreateArgs>) {
        const opts = payload.info;
        const { clientId } = payload.info;
        const connection = createConnection(opts, () => {
            log.info(`Connected to ${opts.host}:${opts.port}`);
            this.redis.hset(REDIS_IRC_POOL_CONNECTIONS, clientId, `${opts.localAddress}:${opts.localPort}`);
            this.connections.set(clientId, connection);
            this.sendCommandOut(OutCommandType.Connected, {
                localIp: connection.localAddress ?? "unknown",
                localPort: connection.localPort ?? -1,
                clientId,
            });
        });

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

            this.redis.xaddBuffer(REDIS_IRC_POOL_COMMAND_OUT_STREAM, "*", clientId, data).catch((ex) => {
                log.warn(`Unable to send raw read out`, ex);
            })
        });
        connection.on('close', () => {
            this.redis.hdel(REDIS_IRC_POOL_CONNECTIONS, clientId);
            this.connections.delete(clientId);
            this.sendCommandOut(OutCommandType.Disconnected, {
                clientId,
            });
        });
    }

    private async handleDestroyCommand(payload: IrcConnectionPoolCommandIn<DestoryArgs>) {
        const connection = this.connections.get(payload.info.clientId);
        if (!connection) {
            log.warn(`Got destroy but no connection matching ${payload.info.clientId} was found`);
            return;
        }
        connection.destroy();
    }

    private async handleEndCommand(payload: IrcConnectionPoolCommandIn<EndArgs>) {
        const connection = this.connections.get(payload.info.clientId);
        if (!connection) {
            log.warn(`Got end but no connection matching ${payload.info.clientId} was found`);
            return;
        }
        connection.end();
    }

    private async handleSetTimeoutCommand(payload: IrcConnectionPoolCommandIn<SetTimeoutArgs>) {
        const connection = this.connections.get(payload.info.clientId);
        if (!connection) {
            log.warn(`Got set-timeout but no connection matching ${payload.info.clientId} was found`);
            return;
        }
        connection.setTimeout(payload.info.timeout);
    }

    private async handleWriteCommand(payload: IrcConnectionPoolCommandIn<WriteArgs>) {
        const connection = this.connections.get(payload.info.clientId);
        if (!connection) {
            log.warn(`Got write but no connection matching ${payload.info.clientId} was found`);
            return;
        }
        connection.write(payload.info.data);
    }

    private async handleCommand(type: InCommandType, payload: IrcConnectionPoolCommandIn) {
        // TODO: Ignore stale commands
        switch (type) {
            case InCommandType.Connect:
                // Spawn a connection
                await this.handleConnectCommand(payload as IrcConnectionPoolCommandIn<ConnectionCreateArgs>);
                break;
            case InCommandType.Destroy:
                // Spawn a connection
                await this.handleDestroyCommand(payload as IrcConnectionPoolCommandIn<DestoryArgs>);
                break;
            case InCommandType.End:
                // Spawn a connection
                await this.handleEndCommand(payload as IrcConnectionPoolCommandIn<EndArgs>);
                break;
            case InCommandType.SetTimeout:
                // Spawn a connection
                await this.handleSetTimeoutCommand(payload as IrcConnectionPoolCommandIn<SetTimeoutArgs>);
                break;
            case InCommandType.Write:
                // Spawn a connection
                await this.handleWriteCommand(payload as IrcConnectionPoolCommandIn<WriteArgs>);
                break;
            default:
                throw new CommandError("Type not understood", type);
        }
    }

    public async main() {
        // Register yourself with redis
        await this.redis.hset(REDIS_IRC_POOL_KEY, this.serviceName, Date.now());

        // Fetch the last read index.
        this.commandsInLastRead =
            await this.redis.get(REDIS_IRC_POOL_COMMAND_IN_STREAM_LAST_READ + this.serviceName) || "$";

        // Warn of any existing connections. TODO: This assumes one service process.
        await this.redis.del(REDIS_IRC_POOL_CONNECTIONS);
        await this.redis.del(REDIS_IRC_CLIENT_STATE_KEY);

        setTimeout(() => {
            this.redis.xtrim(REDIS_IRC_POOL_COMMAND_IN_STREAM, "MAXLEN", "~", 50).then(trimCount => {
                log.debug(`Trimmed ${trimCount} commands from the IN stream`);
            }).catch((ex) => {
                log.warn(`Failed to trim commands from the IN stream`, ex);
            });
            this.redis.xtrim(REDIS_IRC_POOL_COMMAND_OUT_STREAM, "MAXLEN", "~", 50).then(trimCount => {
                log.debug(`Trimmed ${trimCount} commands from the OUT stream`);
            }).catch((ex) => {
                log.warn(`Failed to trim commands from the OUT stream`, ex);
            });
        }, 10000);


        log.info(`Listening for new commands`);
        while (true) {
            const newCmd = await this.cmdReader.xread(
                "BLOCK", 0, "STREAMS", REDIS_IRC_POOL_COMMAND_IN_STREAM, this.commandsInLastRead);
            if (newCmd === null) {
                // Unexpected, this is blocking.
                continue;
            }
            const [msgId, [cmdType, payload]] = newCmd[0][1][0];

            const commandType = cmdType as InCommandType;

            // If we crash, we don't want to get stuck on this msg.
            await this.updateLastRead(msgId);
            const commandData = JSON.parse(payload) as IrcConnectionPoolCommandIn;
            setImmediate(
                () => this.handleCommand(commandType, commandData)
                    .catch(ex => log.warn(`Failed to handle msg ${msgId} (${commandType}, ${payload})`, ex)
                    ),
            );
        }
    }
}

Logger.configure({ console: "debug" });

new IrcConnectionPool().main().then(() => {
    log.info('Pool started');
}).catch(ex => {
    log.error('Pool ended', ex);
});
