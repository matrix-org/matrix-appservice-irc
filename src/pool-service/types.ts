import { TcpNetConnectOpts } from "node:net";
import { ConnectionOptions as TlsConnectionOptions } from "node:tls";

/**
 * This number states the current protocol version of the pool. This
 * should be incremented by developers when an incompatibile change is
 * made to the pool and must be restarted for safe operation.
 */
export const PROTOCOL_VERSION = 0;

export const REDIS_IRC_POOL_VERSION_KEY = "ircbridge.poolversion";
export const REDIS_IRC_POOL_HEARTBEAT_KEY = "ircbridge.pool.💓";
export const REDIS_IRC_POOL_COMMAND_OUT_STREAM = "ircbridge.stream.command.out";
export const REDIS_IRC_POOL_COMMAND_IN_STREAM = "ircbridge.stream.command.in";

export const REDIS_IRC_POOL_COMMAND_OUT_STREAM_LAST_READ = "ircbridge.stream.out.command.last-read";

export const REDIS_IRC_POOL_CONNECTIONS = "ircbridge.connections";
export const REDIS_IRC_CLIENT_STATE_KEY = `ircbridge.clientstate`; //client-id
export type ClientId = string;

export const HEARTBEAT_EVERY_MS = 5000;

export interface ConnectionCreateArgs extends TcpNetConnectOpts {
    clientId: ClientId;
    selfSigned?: boolean;
    certExpired?: boolean;
    secure?: boolean|TlsConnectionOptions;
}

export enum InCommandType {
    Connect = "connect",
    Destroy = "destroy",
    End = "end",
    SetTimeout = "set-timeout",
    Write = "write",
    ConnectionPing = "connection-ping",
    Ping = "ping",
}

export type InCommandPayload = {
    [key in InCommandType]: unknown;
} & {
    [InCommandType.Connect]: ConnectionCreateArgs;
    [InCommandType.Destroy]: { clientId: ClientId };
    [InCommandType.ConnectionPing]: { clientId: ClientId };
    [InCommandType.End]: { clientId: ClientId };
    [InCommandType.Write]: { clientId: ClientId, data: string };
    [InCommandType.SetTimeout]: { clientId: ClientId, timeout: number };
    [InCommandType.Ping]: Record<string, never>;
};

export interface IrcConnectionPoolCommandIn<T extends InCommandType = InCommandType> {
    info: InCommandPayload[T];
    origin_ts: number;
}

export const READ_BUFFER_MAGIC_BYTES = Buffer.from('💾');

export enum OutCommandType {
    Connected = "connected",
    Error = "error",
    Disconnected = "disconnected",
    NotConnected = "not-connected",
    Pong = "pong",
    PoolClosing = "poolclosing",
    // Read = "read", -> This is actually sent as
    // ClientId:Buffer to prevent having to parse the buffer into JSON and back again.
}


export interface DisconnectedStatus {
    clientId: ClientId;
}

export interface ConnectedStatus {
    clientId: ClientId;
    localIp?: string;
    localPort?: number;
}

export interface ErrorStatus {
    clientId: ClientId;
    error: string;
}

export type OutCommandPayload = {
    [key in OutCommandType]: unknown;
} & {
    [OutCommandType.Connected]: ConnectedStatus;
    [OutCommandType.Error]: ErrorStatus;
    [OutCommandType.Disconnected]: DisconnectedStatus;
    [OutCommandType.NotConnected]: { clientId: ClientId };
    [OutCommandType.Pong]: Record<string, never>;
    [OutCommandType.PoolClosing]: Record<string, never>;
};

export interface IrcConnectionPoolCommandOut<T extends OutCommandType = OutCommandType> {
    info: OutCommandPayload[T];
    origin_ts: number;
}

export class CommandError extends Error {
    constructor(message: string, commandType: OutCommandType|InCommandType) {
        super(`Failed to handle command ${commandType}: ${message}`);
    }
}
