import { TcpNetConnectOpts } from "node:net";
import { ConnectionOptions as TlsConnectionOptions } from "node:tls";

export const REDIS_IRC_POOL_KEY = "ircbridge.connectionpools";
export const REDIS_IRC_POOL_COMMAND_OUT_STREAM = "ircbridge.stream.command.out";
export const REDIS_IRC_POOL_COMMAND_IN_STREAM = "ircbridge.stream.command.in";
export const REDIS_IRC_POOL_COMMAND_IN_STREAM_LAST_READ = "ircbridge.stream.command.last-read." // .pool-name;

export const REDIS_IRC_POOL_CONNECTIONS = "ircbridge.connections";
export const REDIS_IRC_CLIENT_STATE_KEY = `ircbridge.clientstate`; //client-id
export type ClientId = string;

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

export enum OutCommandType {
    Connected = "connected",
    Error = "error",
    Disconnected = "disconnected",
    NotConnected = "not-connected",
    Pong = "pong",
    // Read = "read", -> This is actually sent as
    // ClientId:Buffer to prevent having to parse the buffer into JSON and back again.
}


export interface DisconnectedStatus {
    clientId: ClientId,
}

export interface ConnectedStatus {
    clientId: ClientId,
    localIp?: string;
    localPort?: number;
}

export interface ErrorStatus {
    clientId: ClientId,
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
};

export interface IrcConnectionPoolCommandOut<T extends OutCommandType = OutCommandType> {
    info: OutCommandPayload[T];
    origin_ts: number;
}

export interface IrcConnectionPoolRaw {
    ip: string;
    pool: string;
    raw: Buffer;
    origin_ts: number;
}

export class CommandError extends Error {
    constructor(message: string, commandType: OutCommandType|InCommandType) {
        super(`Failed to handle command ${commandType}: ${message}`);
    }
}
