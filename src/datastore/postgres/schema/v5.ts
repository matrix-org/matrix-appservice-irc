import { PoolClient } from "pg";

export async function runSchema(connection: PoolClient) {
    await connection.query(`
    CREATE INDEX client_config_domain_username_idx ON client_config (domain, (config->>'username'));
    `);
}
