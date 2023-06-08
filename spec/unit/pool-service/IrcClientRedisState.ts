import { DefaultIrcSupported } from "matrix-org-irc";
import { IrcClientRedisState, IrcClientStateDehydrated } from "../../../src/pool-service/IrcClientRedisState";

const userId = "@foo:bar";

function fakeRedis(existingData: string|null = null): any {
    return {
        async hget(key, clientId) {
            if (clientId !== userId) {
                throw Error('Wrong user!');
            }
            return existingData;
        }
    }
}

const EXISTING_STATE: IrcClientStateDehydrated = {
    loggedIn: true,
    registered: true,
    currentNick: "alice",
    whoisData: [],
    nickMod: 0,
    modeForPrefix: {
        50: 'o',
    },
    capabilities: {
        serverCapabilites: ['some'],
        serverCapabilitesSasl: ['caps'],
        userCapabilites: ['for'],
        userCapabilitesSasl: []
    },
    supportedState: DefaultIrcSupported,
    hostMask: "",
    chans: [
        ['fibble', {
            key: '',
            serverName: 'egg',
            users: [
                ['bob', 'o']
            ],
            mode: 'a',
            modeParams: [
                ['o', ['bob']]
            ]
        }]
    ],
    prefixForMode: {
        '+': 'o',
    },
    maxLineLength: 100,
    lastSendTime: 12345,
}

describe("IrcClientRedisState", () => {
    it("should be able to create a fresh state", async () => {
        const state = await IrcClientRedisState.create(
            fakeRedis(),
            userId,
            true
        );
        expect(state.loggedIn).toBeFalse();
        expect(state.registered).toBeFalse();
        expect(state.chans.size).toBe(0);
    });
    it("should be able to load existing state", async () => {
        const state = await IrcClientRedisState.create(
            fakeRedis(JSON.stringify(EXISTING_STATE)),
            userId,
            false
        );
        expect(state.loggedIn).toBeTrue();
        expect(state.registered).toBeTrue();
        expect(state.chans.size).toBe(1);
        console.log(state);
    });
    it('should be able to repair previously buggy state', async () => {
        const existingState = {
            ...EXISTING_STATE,
            chans: [
                [
                    "#matrix-bridge-test",
                    {
                        "key": "#matrix-bridge-test",
                        "serverName": "#matrix-bridge-test",
                        "users": {},
                        "mode": "+Cnst",
                        "modeParams": {},
                        "created": "1683732619"
                    }
                ],
                [
                    "#halfy-plumbs",
                    {
                        "key": "#halfy-plumbs",
                        "serverName": "#halfy-plumbs",
                        "users": {},
                        "mode": "+Cnst",
                        "modeParams": {},
                        "created": "1683732619"
                    }
                ],
            ]
        }
        const state = await IrcClientRedisState.create(
            fakeRedis(JSON.stringify(existingState)),
            userId,
            false
        );
        expect(state.chans.get('#matrix-bridge-test')?.users instanceof Map);
        expect(state.chans.get('#halfy-plumbs')?.users instanceof Map);
    })
});
