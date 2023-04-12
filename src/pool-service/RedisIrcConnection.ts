import { IrcClientState, IrcConnection, IrcConnectionEventsMap } from "matrix-org-irc";
import { ClientId, InCommandType } from "./types";
import { Logger } from 'matrix-appservice-bridge';
import { EventEmitter } from "stream";
import TypedEmitter from "typed-emitter";
import { IrcPoolClient } from "./IrcPoolClient";

export type RedisIrcConnectionEvents = {
    'not-connected': () => void,
}

export class RedisIrcConnection extends (EventEmitter as unknown as
    new () => TypedEmitter<RedisIrcConnectionEvents&IrcConnectionEventsMap>) implements IrcConnection {
    private readonly log = new Logger(`RedisIrcConnection:${this.clientId}`);

    public get connecting() {
        return this.isConnecting;
    }

    private isConnecting = true;

    constructor (private readonly redis: IrcPoolClient,
                public readonly clientId: ClientId,
                public state: IrcClientState) {
        super();
        this.once('connect', () => { this.isConnecting = false });
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
