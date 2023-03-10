
import { Redis } from 'ioredis';
import { ChanData, IrcClientState, WhoisResponse,
    IrcCapabilities, IrcSupported, DefaultIrcSupported } from 'matrix-org-irc';
import { REDIS_IRC_CLIENT_STATE_KEY } from './types';


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
    chans: [string, ChanData][];
    prefixForMode: {
        [mode: string]: string;
    };
    maxLineLength: number;
    lastSendTime: number;
}

class StateBackedMap<K, V> extends Map<K, V> {
    constructor(private readonly onChange: () => void, entries?: readonly (readonly [K, V])[] | null, ) {
        super(entries);
    }

    set(key: K, value: V) {
        super.set(key, value);
        // `this.onChange` isn't defined
        //this.onChange();
        return this;
    }

    clear() {
        super.clear();
        //this.onChange();
    }
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
        this.flush();
    }

    public get registered() {
        if (!this.innerState) {
            throw Error('You must call .hydrate() before using this state');
        }
        return this.innerState.registered;
    }

    public set registered(value) {
        if (!this.innerState) {
            throw Error('You must call .hydrate() before using this state');
        }
        this.innerState.registered = value;
        this.flush();
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
        this.flush();
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
        this.flush();
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
        this.flush();
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
        this.flush();
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
        this.flush();
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
        this.flush();
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
        this.flush();
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
        this.flush();
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
        this.flush();
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
        this.flush();
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
        this.flush();
    }


    public async hydrate() {
        const data = await this.redis.hget(REDIS_IRC_CLIENT_STATE_KEY, this.clientId);
        const deseralisedData = data ? JSON.parse(data) as IrcClientStateDehydrated : {} as Record<string, never>;
        // Deserialise

        // TODO: Validate that some of these exist.
        this.innerState = {
            loggedIn: deseralisedData.loggedIn ?? false,
            registered: deseralisedData.registered ?? false,
            currentNick: deseralisedData.currentNick ?? '',
            nickMod: deseralisedData.nickMod ?? 0,
            whoisData: new StateBackedMap(this.flush.bind(this), deseralisedData.whoisData),
            modeForPrefix: deseralisedData.modeForPrefix ?? { },
            hostMask: deseralisedData.hostMask ?? '',
            // TODO: It's still possible for data to go missing here.
            chans: new StateBackedMap(this.flush.bind(this), deseralisedData.chans),
            maxLineLength: deseralisedData.maxLineLength ?? -1,
            lastSendTime: deseralisedData.lastSendTime ?? 0,
            prefixForMode: deseralisedData.prefixForMode ?? {},
            supportedState: deseralisedData.supportedState ?? DefaultIrcSupported,
            capabilities: new IrcCapabilities(deseralisedData.capabilities),
        };
    }

    public flush() {
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
        return this.redis.hset(REDIS_IRC_CLIENT_STATE_KEY, this.clientId, data);
    }
}
