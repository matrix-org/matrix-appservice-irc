import { createPrivateKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { StringCrypto } from '../../src/datastore/StringCrypto';

describe('StringCrypto', () => {
    let privateKey;
    beforeEach(() => {
        privateKey = createPrivateKey(generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: {
                type: 'spki',
                format: 'pem'
            },
            privateKeyEncoding: {
                type: 'pkcs8',
                format: 'pem',
            }
        }).privateKey);
    });
    it('can encrypt a string', () => {
        const str = new StringCrypto(privateKey).encrypt('This is a string to encrypt');
        expect(Buffer.from(str, 'base64').length).toEqual(256)
    });
    it('can decrypt a string', () => {
        const crypto = new StringCrypto(privateKey);
        const originalText = 'This is another string';
        const encrypedString = crypto.encrypt(originalText);
        expect(crypto.decrypt(encrypedString)).toEqual(originalText);
    });
    it('can encrypt a large string', async () => {
        const crypto = new StringCrypto(privateKey);
        const originalText = randomBytes(8192).toString('base64');
        const encrypedString = await crypto.encryptLargeString(originalText);
        expect(encrypedString.length).toEqual(14920);
    });
    it('can decrypt a large string', async () => {
        const originalText = randomBytes(8192).toString('base64');
        const crypto = new StringCrypto(privateKey);
        const encrypedString = await crypto.encryptLargeString(originalText);
        expect(await crypto.decryptLargeString(encrypedString)).toEqual(originalText);
    });
});
