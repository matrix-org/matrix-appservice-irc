/*
Copyright 2019 - 2023 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { KeyObject, createCipheriv, createDecipheriv, createPrivateKey, privateDecrypt,
    publicEncrypt, randomBytes, scrypt as scryptCb } from "node:crypto";
import { promisify } from "node:util";
import * as fs from "fs";
import { getLogger } from "../logging";

const scrypt = promisify(scryptCb);

const log = getLogger("CryptoStore");
const algorithm = 'aes-256-cbc';

const SALT_ENCODING = 'base64';
const SALT_BYTE_LENGTH = 16;
const SALT_STRING_LENGTH = Buffer.alloc(SALT_BYTE_LENGTH).toString(SALT_ENCODING).length;

const ENCRYPTED_ENCODING = 'base64';

export class StringCrypto {

    constructor(private readonly privateKey: KeyObject) {
        if ((privateKey.asymmetricKeyDetails?.modulusLength || 0) < 2048) {
            throw Error('Key size too small. Your passkey must be at least 2048 bits in length');
        }
    }

    static fromFile(pkeyPath: string): StringCrypto {
        try {
            const privateKeyStr = fs.readFileSync(pkeyPath, "utf8").toString();
            const privateKey = createPrivateKey(privateKeyStr);

            // Test whether key is a valid PEM key (publicEncrypt does internal validation)
            try {
                publicEncrypt(
                    privateKeyStr,
                    Buffer.from("This is a test!")
                );
            }
            catch (err) {
                log.error(`Failed to validate private key: (${err.message})`);
                throw err;
            }

            log.info(`Private key loaded from ${pkeyPath} - IRC password encryption enabled.`);
            return new StringCrypto(privateKey);
        }
        catch (err) {
            log.error(`Could not load private key ${err.message}.`);
            throw err;
        }
    }

    public encrypt(plaintext: string): string {
        const salt = randomBytes(SALT_BYTE_LENGTH).toString(SALT_ENCODING);
        return publicEncrypt(
            this.privateKey,
            Buffer.from(salt + ' ' + plaintext)
        ).toString(ENCRYPTED_ENCODING);
    }

    public decrypt(encryptedString: string): string {
        const decryptedPass = privateDecrypt(
            this.privateKey,
            Buffer.from(encryptedString, ENCRYPTED_ENCODING)
        ).toString();
        // Extract the password by removing the prefixed salt and seperating space
        return decryptedPass.slice(SALT_STRING_LENGTH + 1);
    }

    public async encryptLargeString(plaintext: string): Promise<string> {
        const password = randomBytes(32).toString(ENCRYPTED_ENCODING);
        const key = await scrypt(password, 'salt', 32) as Buffer;
        const iv = randomBytes(16);
        const cipher = createCipheriv(algorithm, key, iv);
        cipher.setEncoding(ENCRYPTED_ENCODING);
        let encrypted = '';
        const secret = this.encrypt(`${key.toString(ENCRYPTED_ENCODING)}_${iv.toString(ENCRYPTED_ENCODING)}`);
        const streamPromise = new Promise<string>((resolve, reject) => {
            cipher.on('error', (err) => reject(err));
            cipher.on('end', () => resolve(
                `lg:${secret}:${encrypted}`
            ));
        });
        cipher.on('data', (chunk) => { encrypted += chunk });
        cipher.write(plaintext);
        cipher.end();
        return streamPromise;
    }

    public async decryptLargeString(encryptedString: string): Promise<string> {
        if (!encryptedString.startsWith('lg:')) {
            throw Error('Not a large string');
        }
        const [, keyPlusIvEnc, data] = encryptedString.split(':', 3);
        const [keyB64, ivB64] = this.decrypt(keyPlusIvEnc).split('_');
        const iv = Buffer.from(ivB64, ENCRYPTED_ENCODING);
        const key = Buffer.from(keyB64, ENCRYPTED_ENCODING);
        const decipher = createDecipheriv(algorithm, key, iv);
        let decrypted = '';
        decipher.on('data', (chunk) => { decrypted += chunk });
        const streamPromise = new Promise<string>((resolve, reject) => {
            decipher.on('error', (err) => reject(err));
            decipher.on('end', () => resolve(decrypted));
        });
        decipher.write(Buffer.from(data, ENCRYPTED_ENCODING));
        decipher.end();
        return streamPromise;
    }
}
