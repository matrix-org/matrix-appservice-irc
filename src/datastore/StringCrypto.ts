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

import * as crypto from "crypto";
import * as fs from "fs";
import { getLogger } from "../logging";

const log = getLogger("CryptoStore");

export class StringCrypto {
    private privateKey!: string;

    public load(pkeyPath: string) {
        try {
            this.privateKey = fs.readFileSync(pkeyPath, "utf8").toString();

            // Test whether key is a valid PEM key (publicEncrypt does internal validation)
            try {
                crypto.publicEncrypt(
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
        const salt = crypto.randomBytes(16).toString('base64');
        return crypto.publicEncrypt(
            this.privateKey,
            Buffer.from(salt + ' ' + plaintext)
        ).toString('base64');
    }

    public decrypt(encryptedString: string): string {
        const decryptedPass = crypto.privateDecrypt(
            this.privateKey,
            Buffer.from(encryptedString, 'base64')
        ).toString();
        // Extract the password by removing the prefixed salt and seperating space
        return decryptedPass.split(' ')[1];
    }
}
