import { PoolClient } from "pg";

export async function runSchema(connection: PoolClient) {
    // Create schema
    await connection.query(`
    CREATE TABLE last_seen (
        user_id	TEXT UNIQUE NOT NULL,
        ts BIGINT NOT NULL
    );
    `);
}
