import { TcpNetConnectOpts } from "net";

export const REDIS_IRC_POOL_KEY = "ircbridge.connectionpools";
export const REDIS_IRC_POOL_COMMAND_OUT_STREAM = "ircbridge.stream.command.out";
export const REDIS_IRC_POOL_COMMAND_IN_STREAM = "ircbridge.stream.command.in";
export const REDIS_IRC_POOL_COMMAND_IN_STREAM_LAST_READ = "ircbridge.stream.command.last-read." // .pool-name;

export const REDIS_IRC_POOL_CONNECTIONS = "ircbridge.connections";
export const REDIS_IRC_CLIENT_STATE_KEY = `ircbridge.clientstate`; //client-id
export type ClientId = string;

export interface ConnectionCreateArgs extends TcpNetConnectOpts {
    clientId: ClientId;
}


export type DestoryArgs = { clientId: ClientId };
export type EndArgs = { clientId: ClientId };
export type SetTimeoutArgs = { clientId: ClientId, timeout: number };
export type WriteArgs = { clientId: ClientId, data: string };

export type InCommandPayload = ConnectionCreateArgs|DestoryArgs|EndArgs|SetTimeoutArgs|WriteArgs;

export enum InCommandType {
    Connect = "connect",
    Destroy = "destroy",
    End = "end",
    SetTimeout = "set-timeout",
    Write = "write",
}

export interface IrcConnectionPoolCommandIn<T = InCommandPayload> {
    info: T;
    origin_ts: number;
}

export enum OutCommandType {
    Connected = "connected",
    Error = "error",
    Disconnected = "disconnected",
    // Read = "read", -> This is actually sent as ClientId:Buffer to prevent having to send a descriptive JSON packet
}


export interface DisconnectedStatus {
    clientId: ClientId,
}

export interface ConnectedStatus {
    clientId: ClientId,
    localIp: string;
    localPort: number;
}

export interface ErrorStatus {
    clientId: ClientId,
    error: string;
}

export type OutCommandPayload = ConnectedStatus|ErrorStatus|DisconnectedStatus;

export interface IrcConnectionPoolCommandOut<T = OutCommandPayload> {
    info: T;
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
