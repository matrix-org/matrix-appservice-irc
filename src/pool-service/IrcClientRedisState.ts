
import { Redis } from 'ioredis';
import { ChanData, IrcClientState, WhoisResponse, IrcCapabilities, IrcSupported } from 'matrix-org-irc';

const REDIS_CLIENT_STATE_KEY = `ircbridge.clientstate.`; //client-id

interface IrcClientStateDehydrated {
    loggedIn: boolean;
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
    chans: [string, ChanData][];
    prefixForMode: {
        [mode: string]: string;
    };
    maxLineLength: number;
    lastSendTime: number;
}

export class IrcClientRedisState implements IrcClientState {

    private putStatePromise: Promise<void> = Promise.resolve();
    private innerState?: IrcClientState;

    constructor(private readonly redis: Redis, private readonly clientId: string) {

    }

    public get loggedIn() {
        if (!this.innerState) {
            throw Error('You must call .hydrate() before using this state');
        }
        return this.innerState.loggedIn;
    }

    public set loggedIn(value) {
        if (!this.innerState) {
            throw Error('You must call .hydrate() before using this state');
        }
        this.innerState.loggedIn = value;
        this.putState();
    }

    public get currentNick() {
        if (!this.innerState) {
            throw Error('You must call .hydrate() before using this state');
        }
        return this.innerState.currentNick;
    }

    public set currentNick(value) {
        if (!this.innerState) {
            throw Error('You must call .hydrate() before using this state');
        }
        this.innerState.currentNick = value;
        this.putState();
    }

    public get whoisData() {
        if (!this.innerState) {
            throw Error('You must call .hydrate() before using this state');
        }
        return this.innerState.whoisData;
    }

    public set whoisData(value) {
        if (!this.innerState) {
            throw Error('You must call .hydrate() before using this state');
        }
        this.innerState.whoisData = value;
        this.putState();
    }

    public get nickMod() {
        if (!this.innerState) {
            throw Error('You must call .hydrate() before using this state');
        }
        return this.innerState.nickMod;
    }

    public set nickMod(value) {
        if (!this.innerState) {
            throw Error('You must call .hydrate() before using this state');
        }
        this.innerState.nickMod = value;
        this.putState();
    }

    public get modeForPrefix() {
        if (!this.innerState) {
            throw Error('You must call .hydrate() before using this state');
        }
        return this.innerState.modeForPrefix;
    }

    public set modeForPrefix(value) {
        if (!this.innerState) {
            throw Error('You must call .hydrate() before using this state');
        }
        this.innerState.modeForPrefix = value;
        this.putState();
    }

    public get capabilities() {
        if (!this.innerState) {
            throw Error('You must call .hydrate() before using this state');
        }
        return this.innerState.capabilities;
    }

    public set capabilities(value) {
        if (!this.innerState) {
            throw Error('You must call .hydrate() before using this state');
        }
        this.innerState.capabilities = value;
        this.putState();
    }

    public get supportedState() {
        if (!this.innerState) {
            throw Error('You must call .hydrate() before using this state');
        }
        return this.innerState.supportedState;
    }

    public set supportedState(value) {
        if (!this.innerState) {
            throw Error('You must call .hydrate() before using this state');
        }
        this.innerState.supportedState = value;
        this.putState();
    }

    public get hostMask() {
        if (!this.innerState) {
            throw Error('You must call .hydrate() before using this state');
        }
        return this.innerState.hostMask;
    }

    public set hostMask(value) {
        if (!this.innerState) {
            throw Error('You must call .hydrate() before using this state');
        }
        this.innerState.hostMask = value;
        this.putState();
    }

    public get chans() {
        if (!this.innerState) {
            throw Error('You must call .hydrate() before using this state');
        }
        return this.innerState.chans;
    }

    public set chans(value) {
        if (!this.innerState) {
            throw Error('You must call .hydrate() before using this state');
        }
        this.innerState.chans = value;
        this.putState();
    }

    public get prefixForMode() {
        if (!this.innerState) {
            throw Error('You must call .hydrate() before using this state');
        }
        return this.innerState.prefixForMode;
    }

    public set prefixForMode(value) {
        if (!this.innerState) {
            throw Error('You must call .hydrate() before using this state');
        }
        this.innerState.prefixForMode = value;
        this.putState();
    }

    public get maxLineLength() {
        if (!this.innerState) {
            throw Error('You must call .hydrate() before using this state');
        }
        return this.innerState.maxLineLength;
    }

    public set maxLineLength(value) {
        if (!this.innerState) {
            throw Error('You must call .hydrate() before using this state');
        }
        this.innerState.maxLineLength = value;
        this.putState();
    }

    public get lastSendTime() {
        if (!this.innerState) {
            throw Error('You must call .hydrate() before using this state');
        }
        return this.innerState.lastSendTime;
    }

    public set lastSendTime(value) {
        if (!this.innerState) {
            throw Error('You must call .hydrate() before using this state');
        }
        this.innerState.lastSendTime = value;
        this.putState();
    }


    public async hydrate() {
        const data = await this.redis.get(`${REDIS_CLIENT_STATE_KEY}.${this.clientId}`);
        const deseralisedData = data ? JSON.parse(data) as IrcClientStateDehydrated : {} as Record<string, never>;
        // Deserialise

        // TODO: Validate that some of these exist.
        this.innerState = {
            loggedIn: deseralisedData.loggedIn ?? false,
            currentNick: deseralisedData.currentNick ?? '',
            nickMod: deseralisedData.nickMod ?? 0,
            whoisData: new Map(deseralisedData.whoisData),
            modeForPrefix: deseralisedData.modeForPrefix,
            hostMask: deseralisedData.hostMask ?? '',
            chans: new Map(deseralisedData.chans),
            maxLineLength: deseralisedData.maxLineLength ?? -1,
            lastSendTime: deseralisedData.lastSendTime ?? 0,
            prefixForMode: deseralisedData.prefixForMode,
            supportedState: deseralisedData.supportedState,
            capabilities: new IrcCapabilities(deseralisedData.capabilities),
        };
    }

    private putState() {
        if (!this.innerState) {
            throw Error('You must call .hydrate() before using this state');
        }
        const serialState = JSON.stringify({
            ...this.innerState,
            whoisData: [...this.innerState.whoisData.entries()],
            chans: [...this.innerState.chans.entries()],
            capabilities: this.innerState.capabilities.serialise(),
            supportedState: this.supportedState,
        } as IrcClientStateDehydrated);

        this.putStatePromise = this.putStatePromise.finally(() => {
            return this.innerPutState(serialState);
        });
    }

    private async innerPutState(data: string) {
        return this.redis.set(`${REDIS_CLIENT_STATE_KEY}.${this.clientId}`, data);
    }
}
