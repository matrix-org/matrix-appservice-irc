/*
Copyright 2019 The Matrix.org Foundation C.I.C.

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

import { createCipheriv, createDecipheriv, privateDecrypt, publicEncrypt, scrypt as scryptCb } from "node:crypto";
import * as fs from "fs";
import { getLogger } from "../logging";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

const log = getLogger("CryptoStore");
const algorithm = 'aes-256-cbc';

export class StringCrypto {
    private privateKey!: string;

    public load(pkeyPath: string) {
        try {
            this.privateKey = fs.readFileSync(pkeyPath, "utf8").toString();

            // Test whether key is a valid PEM key (publicEncrypt does internal validation)
            try {
                publicEncrypt(
                    this.privateKey,
                    Buffer.from("This is a test!")
                );
            }
            catch (err) {
                log.error(`Failed to validate private key: (${err.message})`);
                throw err;
            }

            log.info(`Private key loaded from ${pkeyPath} - IRC password encryption enabled.`);
        }
        catch (err) {
            log.error(`Could not load private key ${err.message}.`);
            throw err;
        }
    }

    public encrypt(plaintext: string): string {
        const salt = randomBytes(16).toString('base64');
        return publicEncrypt(
            this.privateKey,
            Buffer.from(salt + ' ' + plaintext)
        ).toString('base64');
    }

    public decrypt(encryptedString: string): string {
        const decryptedPass = privateDecrypt(
            this.privateKey,
            Buffer.from(encryptedString, 'base64')
        ).toString();
        // Extract the password by removing the prefixed salt and seperating space
        return decryptedPass.slice(25);
    }

    public async encryptLargeString(plaintext: string): Promise<string> {
        const password = randomBytes(32).toString('base64');
        const key = await scrypt(password, 'salt', 32) as Buffer;
        const iv = randomBytes(16);
        const cipher = createCipheriv(algorithm, key, iv);
        cipher.setEncoding('base64');
        let encrypted = '';
        const secret = this.encrypt(`${key.toString('base64')}_${iv.toString('base64')}`);
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
        const iv = Buffer.from(ivB64, "base64");
        const key = Buffer.from(keyB64, "base64");
        const decipher = createDecipheriv(algorithm, key, iv);
        let decrypted = '';
        decipher.on('data', (chunk) => { decrypted += chunk });
        const streamPromise = new Promise<string>((resolve, reject) => {
            decipher.on('error', (err) => reject(err));
            decipher.on('end', () => resolve(decrypted));
        });
        decipher.write(Buffer.from(data, 'base64'));
        decipher.end();
        return streamPromise;
    }
}
