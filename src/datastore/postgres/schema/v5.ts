import { PoolClient } from "pg";

export async function runSchema(connection: PoolClient) {
    await connection.query(`
    CREATE TABLE client_cert (
        user_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        cert TEXT NOT NULL,
        key TEXT NOT NULL,
        CONSTRAINT cons_client_cert_unique UNIQUE(user_id, domain)
    );`);
}
