import { PoolClient } from "pg";

export async function runSchema(connection: PoolClient) {
    await connection.query(`
    DROP INDEX client_config_domain_username_idx;
    `);
}
