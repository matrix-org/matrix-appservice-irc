import { IrcClientState, IrcConnection, IrcConnectionEventsMap } from "matrix-org-irc";
import { ClientId, InCommandType, IrcConnectionPoolCommandOut, OutCommandType } from "./types";
import { Logger } from 'matrix-appservice-bridge';
import { EventEmitter } from "node:stream";
import TypedEmitter from "typed-emitter";
import { IrcPoolClient } from "./IrcPoolClient";

export type RedisIrcConnectionEvents = {
    'not-connected': () => void,
}

export class RedisIrcConnection extends (EventEmitter as unknown as
    new () => TypedEmitter<RedisIrcConnectionEvents&IrcConnectionEventsMap>) implements IrcConnection {
    private readonly log: Logger;

    public get connecting() {
        return this.isConnecting;
    }

    public get readyState() {
        // TODO: Should this be just pulled directly from the socket.
        // No support for readonly / writeonly.
        return this.isConnecting ? 'opening' : 'open';
    }

    private isConnecting = true;
    public localPort?: number;
    public localIp?: string;

    constructor (private readonly redis: IrcPoolClient,
                public readonly clientId: ClientId,
                public state: IrcClientState) {
        super();
        this.log = new Logger(`RedisIrcConnection:${this.clientId}`);
        this.once('connect', () => {
            this.isConnecting = false;
        });
    }

    setConnectionInfo(info: IrcConnectionPoolCommandOut<OutCommandType.Connected>["info"]) {
        this.localPort = info.localPort;
        this.localIp = info.localIp;
    }

    setTimeout(timeout: number) {
        this.redis.sendCommand(InCommandType.SetTimeout, { clientId: this.clientId, timeout }).catch(ex => {
            this.log.warn(`Could not send setTimeout:`, ex);
        });
    }

    destroy() {
        this.log.debug(`Called destroy`);
        this.redis.sendCommand(InCommandType.Destroy, { clientId: this.clientId }).catch(ex => {
            this.log.warn(`Could not send destroy:`, ex);
        });
    }

    write(data: string): void {
        this.redis.sendCommand(InCommandType.Write, { clientId: this.clientId, data }).catch(ex => {
            this.log.warn(`Could not send write:`, ex);
        });
    }

    end(): void {
        this.log.debug(`Called end`);
        this.redis.sendCommand(InCommandType.End, { clientId: this.clientId }).catch(ex => {
            this.log.warn(`Could not send end:`, ex);
        });
    }
}
