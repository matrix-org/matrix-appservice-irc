import { TestIrcServer } from "matrix-org-irc";
import { IrcBridgeE2ETest } from "../util/e2e-test";
import { describe, it } from "@jest/globals";
import { delay } from "../../src/promiseutil";
import { exec } from "node:child_process";
import { getKeyPairFromString } from "../../src/bridge/AdminRoomHandler";
import { randomUUID } from "node:crypto";

async function generateCertificatePair() {
    return new Promise<ReturnType<typeof getKeyPairFromString>>((resolve, reject) => {
        exec(
            'openssl req -nodes -newkey rsa:2048 -keyout - -x509 -days 3 -out -' +
            ' -subj "/C=US/ST=Utah/L=Lehi/O=Your Company, Inc./OU=IT/CN=yourdomain.com"', {
                timeout: 5000,
            },
            (err, stdout) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(getKeyPairFromString(stdout));
            });
    })
}


async function expectMsg(msgSet: string[], expected: string, timeoutMs = 5000) {
    let waitTime = 0;
    do {
        waitTime += 200;
        await delay(200);
        if (waitTime > timeoutMs) {
            throw Error(`Timeout waiting for "${expected}, instead got\n\t${msgSet.join('\n\t')}"`);
        }
    } while (!msgSet.includes(expected))
}

const PASSWORD = randomUUID();

/**
 * Note, this test assumes the IRCD we're testing against has services enabled
 * and certfp support. This isn't terribly standard, but we test with ergo which
 * has all this supported.
 */
describe('Authentication tests', () => {
    let testEnv: IrcBridgeE2ETest;
    let certPair: ReturnType<typeof getKeyPairFromString>;
    beforeEach(async () => {
        certPair = await generateCertificatePair();
        testEnv = await IrcBridgeE2ETest.createTestEnv({
            matrixLocalparts: [TestIrcServer.generateUniqueNick("alice")],
            ircNicks: ["bob_authtest"],
            traceToFile: true,
        });
        await testEnv.setUp();
    });
    afterEach(() => {
        return testEnv?.tearDown();
    });
    it('should be able to add a client certificate with the !certfp command', async () => {
        const { homeserver, ircBridge } = testEnv
        const aliceUserId = homeserver.users[0].userId;
        const alice = homeserver.users[0].client;
        const { bob_authtest: bob } = testEnv.ircTest.clients;
        const nickServMsgs: string[] = [];
        const adminRoomPromise = await testEnv.createAdminRoomHelper(alice);
        const channel = TestIrcServer.generateUniqueChannel('authtest');
        bob.on('notice', (from, _to, notice) => {
            if (from === 'NickServ') {
                nickServMsgs.push(notice);
            }
        });
        await bob.say('NickServ', `REGISTER ${PASSWORD}}`);
        await expectMsg(nickServMsgs, 'Account created');
        await expectMsg(nickServMsgs, `You're now logged in as ${bob.nick}`);
        bob.say('NickServ', `CERT ADD ${certPair.cert.fingerprint256}`);
        await expectMsg(nickServMsgs, 'Certificate fingerprint successfully added');

        const adminRoomId = adminRoomPromise;
        const responseOne = alice.waitForRoomEvent({ eventType: 'm.room.message', sender: ircBridge.appServiceUserId });
        await alice.sendText(adminRoomId, '!certfp');
        expect((await responseOne).data.content.body).toEqual(
            "Please enter your certificate and private key (without formatting) for localhost. Say 'cancel' to cancel."
        );
        const responseTwo = alice.waitForRoomEvent({ eventType: 'm.room.message', sender: ircBridge.appServiceUserId });
        await alice.sendText(adminRoomId,
            certPair.cert.toString()+"\n"+certPair.privateKey.export({type: "pkcs8", format: "pem"})
        );
        expect((await responseTwo).data.content.body).toEqual(
            'Successfully stored certificate for localhost. Use !reconnect to use this cert.'
        );

        await testEnv.joinChannelHelper(alice, adminRoomId, channel);
        const bridgedClient = await ircBridge.getBridgedClientsForUserId(aliceUserId)[0];
        const aliceIrcClient = await bridgedClient.waitForConnected().then(() => bridgedClient.assertConnected());
        // Slight gut wrenching to get the fingerprint out.
        const getCertResponse = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timed out getting cert response')), 5000);
            aliceIrcClient.on('raw', (msg) => {
                console.log(msg);
                if (msg.rawCommand === '276') {
                    clearTimeout(timeout);
                    resolve(msg);
                }
            });
        })
        bridgedClient.whois(bridgedClient.nick);
        console.log(await getCertResponse);
    });
});
