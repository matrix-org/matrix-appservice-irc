import Redis from "ioredis";
import { IrcClientRedisState } from "./IrcClientRedisState";
import { RedisIrcConnection } from "./RedisIrcConnection";
import { ClientId, ConnectionCreateArgs, HEARTBEAT_EVERY_MS,
    InCommandPayload, InCommandType, IrcConnectionPoolCommandIn,
    IrcConnectionPoolCommandOut,
    OutCommandType,
    PROTOCOL_VERSION,
    REDIS_IRC_POOL_COMMAND_IN_STREAM, REDIS_IRC_POOL_COMMAND_OUT_STREAM,
    REDIS_IRC_POOL_CONNECTIONS, REDIS_IRC_POOL_HEARTBEAT_KEY, REDIS_IRC_POOL_VERSION_KEY } from "./types";

import { Logger } from 'matrix-appservice-bridge';
const log = new Logger('IrcPoolClient');

const CONNECTION_TIMEOUT = 20000;

export class IrcPoolClient {
    private readonly redis: Redis;
    private readonly connections = new Map<ClientId, Promise<RedisIrcConnection>>();
    public shouldRun = true;
    private commandStreamId = "$";
    cmdReader: Redis;

    constructor(url: string) {
        this.redis = new Redis(url, {
            lazyConnect: true,
        });
        this.cmdReader = new Redis(url, {
            lazyConnect: true,
        });
    }

    public async sendCommand<T extends InCommandType>(type: T, payload: InCommandPayload[T]) {
        await this.redis.xadd(REDIS_IRC_POOL_COMMAND_IN_STREAM, "*", type, JSON.stringify({
            origin_ts: Date.now(),
            info: payload,
        } as IrcConnectionPoolCommandIn<T>));
        log.debug(`Sent command in ${type}: ${payload}`);
    }

    public async createOrGetIrcSocket(clientId: string, netOpts: ConnectionCreateArgs): Promise<RedisIrcConnection> {
        const existingConnection = this.connections.get(clientId);
        if (existingConnection) {
            log.warn(`Re-requested ${clientId} within a session, which might indicate a logic error`);
            return existingConnection;
        }
        log.info(`Requesting new client ${clientId}`);
        // Check to see if one exists.
        const state = await this.redis.hget(REDIS_IRC_POOL_CONNECTIONS, clientId);
        const clientPromise = IrcClientRedisState.create(this.redis, clientId).then((clientState) => {
            return new RedisIrcConnection(this, clientId, clientState);
        });
        this.connections.set(clientId, clientPromise);
        const client = await clientPromise;

        try {
            if (!state) {
                log.info(`Requesting new connection for ${clientId}`);
                await this.sendCommand(InCommandType.Connect, netOpts);
                // Wait to be told we connected.
            }
            else {
                log.info(`${clientId} is still connected, not requesting connection`);
                await this.sendCommand(InCommandType.ConnectionPing, { clientId });
            }

            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    log.warn(`Connection ${clientId} timed out`);
                    reject(new Error('Connection timed out'))
                }, CONNECTION_TIMEOUT);
                client.once('connect', () => {
                    clearTimeout(timeout);
                    resolve();
                });
                client.once('not-connected', () => {
                    clearTimeout(timeout);
                    reject(new Error('Client was not connected'));
                });
                client.once('error', (err) => {
                    clearTimeout(timeout);
                    reject(err);
                });
            });
            log.info(`Resolved connection for ${clientId}`);

            return client;
        }
        catch (ex) {
            // Clean up after so we can have another attempt
            this.connections.delete(clientId);
            log.warn(`Failed to create client ${clientId}`, ex);
            throw Error(`Failed to create client ${clientId}: ${ex.message}`);
        }
    }

    // eslint-disable-next-line max-len
    private async handleCommand<T extends OutCommandType>(commandTypeOrClientId: T|ClientId, commandData: IrcConnectionPoolCommandOut<T>|Buffer) {
        // I apologise about this insanity.
        const connection = await (Buffer.isBuffer(commandData) ?
            this.connections.get(commandTypeOrClientId) : this.connections.get(commandData.info.clientId));
        if (Buffer.isBuffer(commandData)) {
            log.debug(`Got incoming write ${commandTypeOrClientId}  (${commandData.byteLength} bytes)`);
        }
        else {
            log.debug(`Got incoming ${commandTypeOrClientId} for ${commandData.info.clientId}`);
        }
        if (!connection) {
            log.warn(`Got command ${commandTypeOrClientId} but no client was connected`);
            return;
        }

        switch (commandTypeOrClientId) {
            case OutCommandType.Connected:
                connection.emit('connect');
                break;
            case OutCommandType.Disconnected:
                connection.emit('end');
                break;
            case OutCommandType.NotConnected:
                connection.emit('not-connected');
                break;
            case OutCommandType.Error:
                connection.emit('error',
                    new Error((commandData as IrcConnectionPoolCommandOut<OutCommandType.Error>).info.error)
                );
                break;
            default:
                // eslint-disable-next-line no-case-declarations
                const buffer = commandData as Buffer;
                connection.emit('data', buffer);
                break;
        }
    }

    public close() {
        this.shouldRun = false;
        this.redis.disconnect();
        this.cmdReader.disconnect();
    }

    public async handleIncomingCommand() {
        const newCmd = await this.cmdReader.xread(
            "BLOCK", 0, "STREAMS", REDIS_IRC_POOL_COMMAND_OUT_STREAM, this.commandStreamId
        );
        if (newCmd === null) {
            // Unexpected, this is blocking.pp
            return;
        }
        const [msgId, [cmdType, payload]] = newCmd[0][1][0];
        this.commandStreamId = msgId;

        const commandType = cmdType as OutCommandType|ClientId;
        let commandData: IrcConnectionPoolCommandOut|Buffer;
        if (typeof payload === 'string' && payload[0] === '{') {
            commandData = JSON.parse(payload) as IrcConnectionPoolCommandOut;
        }
        else {
            commandData = Buffer.from(payload);
        }
        setImmediate(
            () => this.handleCommand(commandType, commandData)
                .catch(ex => log.warn(`Failed to handle msg ${msgId} (${commandType}, ${payload})`, ex)
                ),
        );
    }

    public async listen() {
        log.info(`Listening for new commands`);
        let loopCommandCheck: () => void;

        // First, check if the pool is up.
        const lastHeartbeat = parseInt(await this.redis.get(REDIS_IRC_POOL_HEARTBEAT_KEY) ?? '0');
        if (lastHeartbeat + HEARTBEAT_EVERY_MS + 1000 < Date.now()) {
            // Heartbeat is stale or missing, might not be running!
            throw Error('IRC pool is not running!');
        }

        const version = parseInt(await this.redis.get(REDIS_IRC_POOL_VERSION_KEY) ?? '-1');
        if (version < PROTOCOL_VERSION) {
            // Heartbeat is stale or missing, might not be running!
            throw Error(
                `IRC pool is running an older version (${version})` +
                `of the protocol than the bridge (${PROTOCOL_VERSION}). Restart the pool.`
            );
        }

        // eslint-disable-next-line prefer-const
        loopCommandCheck = () => {
            if (!this.shouldRun) {
                log.info(`Finished`);
                // TODO: Shutdown any connections gracefully.
                return;
            }
            this.handleIncomingCommand().finally(() => {
                return loopCommandCheck();
            });
        }

        loopCommandCheck();
    }
}
