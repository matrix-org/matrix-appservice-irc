
import { Redis } from 'ioredis';
import { IrcClientState, WhoisResponse,
    IrcCapabilities, IrcSupported, DefaultIrcSupported, ChanData } from 'matrix-org-irc';
import { REDIS_IRC_CLIENT_STATE_KEY } from './types';
import * as Logger from "../logging";

const log = Logger.get('IrcClientRedisState');

interface ChanDataDehydrated {
    created?: string;
    key: string;
    serverName: string;
    /**
     * nick => mode
     */
    users: [string, string][];
    mode: string;
    modeParams: [string, string[]][];
    topic?: string;
    topicBy?: string;
}

interface IrcClientStateDehydrated {
    loggedIn: boolean;
    registered: boolean;
    /**
    * This will either be the requested nick or the actual nickname.
    */
    currentNick: string;
    whoisData: [string, WhoisResponse][];
    nickMod: number;
    modeForPrefix: {
        [prefix: string]: string;
    };
    capabilities: ReturnType<IrcCapabilities["serialise"]>;
    supportedState: IrcSupported;
    hostMask: string;
    chans: [string, ChanDataDehydrated][];
    prefixForMode: {
        [mode: string]: string;
    };
    maxLineLength: number;
    lastSendTime: number;
}


export class IrcClientRedisState implements IrcClientState {
    private putStatePromise: Promise<void> = Promise.resolve();

    static async create(redis: Redis, clientId: string) {
        const data = await redis.hget(REDIS_IRC_CLIENT_STATE_KEY, clientId);
        const deseralisedData = data ? JSON.parse(data) as IrcClientStateDehydrated : {} as Record<string, never>;
        const chans = new Map<string, ChanData>();
        if (Array.isArray(deseralisedData.chans)) {
            deseralisedData.chans.forEach(([channelName, chanData]) => {
                chans.set(channelName, {
                    ...chanData,
                    users: new Map(chanData.users),
                    modeParams: new Map(chanData.modeParams),
                })
            })
        }
        else {
            // Old broken state, reset
        }

        // The client library is currently responsible for flushing any new changes
        // to the state so we do not need to detect changes in this class.
        // In the future this may change.
        const innerState = {
            loggedIn: deseralisedData.loggedIn ?? false,
            registered: deseralisedData.registered ?? false,
            currentNick: deseralisedData.currentNick ?? '',
            nickMod: deseralisedData.nickMod ?? 0,
            whoisData: new Map(deseralisedData.whoisData),
            modeForPrefix: deseralisedData.modeForPrefix ?? { },
            hostMask: deseralisedData.hostMask ?? '',
            chans,
            maxLineLength: deseralisedData.maxLineLength ?? -1,
            lastSendTime: deseralisedData.lastSendTime ?? 0,
            prefixForMode: deseralisedData.prefixForMode ?? {},
            supportedState: deseralisedData.supportedState ?? DefaultIrcSupported,
            capabilities: new IrcCapabilities(deseralisedData.capabilities),
        };
        return new IrcClientRedisState(redis, clientId, innerState);
    }

    private constructor(
        private readonly redis: Redis,
        private readonly clientId: string,
        private readonly innerState: IrcClientState
    ) {

    }

    public get loggedIn() {
        return this.innerState.loggedIn;
    }

    public set loggedIn(value) {
        this.innerState.loggedIn = value;
        this.flush();
    }

    public get registered() {
        return this.innerState.registered;
    }

    public set registered(value) {
        this.innerState.registered = value;
        this.flush();
    }

    public get currentNick() {
        return this.innerState.currentNick;
    }

    public set currentNick(value) {
        this.innerState.currentNick = value;
        this.flush();
    }

    public get whoisData() {
        return this.innerState.whoisData;
    }

    public set whoisData(value) {
        this.innerState.whoisData = value;
        this.flush();
    }

    public get nickMod() {
        return this.innerState.nickMod;
    }

    public set nickMod(value) {
        this.innerState.nickMod = value;
        this.flush();
    }

    public get modeForPrefix() {
        return this.innerState.modeForPrefix;
    }

    public set modeForPrefix(value) {
        this.innerState.modeForPrefix = value;
        this.flush();
    }

    public get capabilities() {
        return this.innerState.capabilities;
    }

    public set capabilities(value) {
        this.innerState.capabilities = value;
        this.flush();
    }

    public get supportedState() {
        return this.innerState.supportedState;
    }

    public set supportedState(value) {
        this.innerState.supportedState = value;
        this.flush();
    }

    public get hostMask() {
        return this.innerState.hostMask;
    }

    public set hostMask(value) {
        this.innerState.hostMask = value;
        this.flush();
    }

    public get chans() {
        return this.innerState.chans;
    }

    public set chans(value) {
        this.innerState.chans = value;
        this.flush();
    }

    public get prefixForMode() {
        return this.innerState.prefixForMode;
    }

    public set prefixForMode(value) {
        this.innerState.prefixForMode = value;
        this.flush();
    }

    public get lastSendTime() {
        return this.innerState.lastSendTime;
    }

    public set lastSendTime(value) {
        this.innerState.lastSendTime = value;
        this.flush();
    }


    public flush() {
        const chans: [string, ChanDataDehydrated][] = [];
        this.innerState.chans.forEach((chanData, channelName) => {
            chans.push([
                channelName,
                {
                    ...chanData,
                    users: [...chanData.users.entries()],
                    modeParams: [...chanData.modeParams.entries()],
                }
            ])
        });

        const serialState = JSON.stringify({
            ...this.innerState,
            whoisData: [...this.innerState.whoisData.entries()],
            chans,
            capabilities: this.innerState.capabilities.serialise(),
            supportedState: this.supportedState,
        } as IrcClientStateDehydrated);

        this.putStatePromise = this.putStatePromise.then(() => {
            return this.innerPutState(serialState).then(() => {
                
            }).catch((ex) => {
                log.warn(`Failed to store state for ${this.clientId}`, ex);
            });
        });
    }

    private async innerPutState(data: string) {
        return this.redis.hset(REDIS_IRC_CLIENT_STATE_KEY, this.clientId, data);
    }
}
