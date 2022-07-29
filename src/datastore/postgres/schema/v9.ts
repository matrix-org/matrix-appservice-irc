import { PoolClient } from "pg";

export async function runSchema(connection: PoolClient) {
    await connection.query(`
        ALTER TABLE client_config ADD COLUMN sasl_cert TEXT;
        ALTER TABLE client_config ADD COLUMN sasl_key TEXT;
    `);
}

