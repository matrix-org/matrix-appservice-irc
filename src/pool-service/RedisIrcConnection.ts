import { Redis } from "ioredis";
import { IrcClientState, IrcConnection, IrcConnectionEventEmitter } from "matrix-org-irc";
import { ClientId, InCommandPayload, InCommandType,
    IrcConnectionPoolCommandIn,
    REDIS_IRC_POOL_COMMAND_IN_STREAM } from "./types";
import { Logger } from 'matrix-appservice-bridge';
import { EventEmitter } from "stream";


export class RedisIrcConnection extends (
    EventEmitter as unknown as new () => IrcConnectionEventEmitter) implements IrcConnection {
    private readonly log = new Logger(`RedisIrcConnection:${this.clientId}`);

    public onConnectedPromise: Promise<void>;

    // Assigned slightly asynchronously.
    public onConnected!: () => void;

    constructor (private readonly redis: Redis,
        public readonly clientId: ClientId,
        public state: IrcClientState) {
        super();
        let timeout :NodeJS.Timeout;
        this.onConnectedPromise = new Promise<void>((resolve, reject) => {
            this.onConnected = () => {
                this.log.info(`Got connected signal`);
                this.emit('connected');
                resolve();
            };
            timeout = setTimeout(() => { reject(new Error('Connection timed out')) }, 60000);
        }).then(() => {
            clearTimeout(timeout);
        });
    }

    private sendCommand(type: InCommandType, payload: InCommandPayload) {
        this.redis.xadd(REDIS_IRC_POOL_COMMAND_IN_STREAM, "*", type, JSON.stringify({
            info: payload,
            origin_ts: Date.now(),
        } as IrcConnectionPoolCommandIn)).catch(ex => {
            this.log.warn(`Could not send command:`, ex);
        });
    }

    setTimeout(timeout: number) {
        this.sendCommand(InCommandType.SetTimeout, { clientId: this.clientId, timeout });
    }
    destroy() {
        this.log.warn(`Called destroy`);
        this.sendCommand(InCommandType.Destroy, { clientId: this.clientId });
    }
    write(data: string): void {
        this.sendCommand(InCommandType.Write, { clientId: this.clientId, data });
    }
    end(): void {
        this.sendCommand(InCommandType.End, { clientId: this.clientId });
    }
}
