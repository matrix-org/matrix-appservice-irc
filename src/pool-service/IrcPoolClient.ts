import Redis from "ioredis";
import { IrcClientRedisState } from "./IrcClientRedisState";
import { RedisIrcConnection } from "./RedisIrcConnection";
import { ClientId, ConnectionCreateArgs, ErrorStatus, InCommandType, IrcConnectionPoolCommandIn,
    IrcConnectionPoolCommandOut,
    OutCommandPayload,
    OutCommandType,
    REDIS_IRC_POOL_COMMAND_IN_STREAM, REDIS_IRC_POOL_COMMAND_OUT_STREAM, REDIS_IRC_POOL_CONNECTIONS } from "./types";

import { Logger } from 'matrix-appservice-bridge';
const log = new Logger('IrcPoolClient');

export class IrcPoolClient {
    private readonly redis: Redis;
    private readonly connections = new Map<ClientId, RedisIrcConnection>();
    public shouldRun = true;
    cmdReader: Redis;

    constructor() {
        this.redis = new Redis({
            host: "localhost",
        });
        this.cmdReader = new Redis({
            host: "localhost",
        });
    }

    public async sendCommand(type: InCommandType, payload: ConnectionCreateArgs) {
        await this.redis.xadd(REDIS_IRC_POOL_COMMAND_IN_STREAM, "*", type, JSON.stringify({
            origin_ts: Date.now(),
            info: payload,
        } as IrcConnectionPoolCommandIn));
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
        log.info(`Requesting new client ${clientId}`, state);
        const clientState = new IrcClientRedisState(this.redis, clientId);
        log.info(`Requesting new client ${clientId}`);
        await clientState.hydrate();
        const client = new RedisIrcConnection(this.redis, clientId, clientState);
        log.info(`Requesting new client ${clientId}`);
        this.connections.set(clientId, client);

        log.info(`Requesting new client ${clientId}`);
        if (!state) {
            log.info(`Requesting new connection for ${clientId}`);
            await this.sendCommand(InCommandType.Connect, netOpts);
            await client.onConnectedPromise;
            // Wait to be told we connected.
        }
        else {
            log.info(`${clientId} is still connected, not requesting connection`);
            // TODO: Check it *still* exists.
        }

        return client;
    }

    // eslint-disable-next-line max-len
    private async handleCommand(commandTypeOrClientId: OutCommandType|ClientId, commandData: IrcConnectionPoolCommandOut<OutCommandPayload>|Buffer) {
        // I apologise about this insanity.
        const connection = Buffer.isBuffer(commandData) ?
            this.connections.get(commandTypeOrClientId) : this.connections.get(commandData.info.clientId);
        log.debug(`Got incoming command ${commandTypeOrClientId}`, commandData);
        switch (commandTypeOrClientId) {
            case OutCommandType.Connected:
                connection?.onConnected();
                break;
            case OutCommandType.Disconnected:
                connection?.emit('end');
                break;
            case OutCommandType.Error:
                connection?.emit('error',
                    new Error((commandData as IrcConnectionPoolCommandOut<ErrorStatus>).info.error)
                );
                break;
            default:
                // eslint-disable-next-line no-case-declarations
                const buffer = commandData as Buffer;
                log.debug(`Got data for ${connection?.clientId}: ${buffer.byteLength}`)
                connection?.emit('data', buffer);
                break;
        }
    }

    public close() {
        this.shouldRun = false;
    }

    public async listen() {
        log.info(`Listening for new commands`);
        while (this.shouldRun) {
            // TODO: Track last-read
            // TODO: Make sure this isn't a supermassive perf hit.
            const newCmd = await this.cmdReader.xread(
                "BLOCK", 0, "STREAMS", REDIS_IRC_POOL_COMMAND_OUT_STREAM, "$");
            if (newCmd === null) {
                // Unexpected, this is blocking.
                continue;
            }
            const [msgId, [cmdType, payload]] = newCmd[0][1][0];

            const commandType = cmdType as OutCommandType|ClientId;
            let commandData: IrcConnectionPoolCommandIn|Buffer;
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
            console.log("Got new cmd:", cmdType, commandData);
        }
        // TODO: Clean-up connections?
        log.info(`Finished`);
    }
}
