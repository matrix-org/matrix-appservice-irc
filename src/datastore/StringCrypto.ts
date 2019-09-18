import * as crypto from "crypto";
import * as fs from "fs";
import * as logging from "../logging";

const log = logging.get("CryptoStore");

export class StringCrypto {
    private privateKey!: string;

    public load(pkeyPath: string) {
        try {
            this.privateKey = fs.readFileSync(pkeyPath, "utf8").toString();

            // Test whether key is a valid PEM key (publicEncrypt does internal validation)
            try {
                crypto.publicEncrypt(
                    this.privateKey,
                    new Buffer("This is a test!")
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
            new Buffer(salt + ' ' + plaintext)
        ).toString('base64');
    }

    public decrypt(encryptedString: string): string {
        const decryptedPass = crypto.privateDecrypt(
            this.privateKey,
            new Buffer(encryptedString, 'base64')
        ).toString();
        // Extract the password by removing the prefixed salt and seperating space
        return decryptedPass.split(' ')[1];
    }
}
