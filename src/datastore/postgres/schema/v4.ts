import { PoolClient } from "pg";

export async function runSchema(connection: PoolClient) {
    // Create schema
    await connection.query(`
    CREATE TABLE deactivated_users (
        user_id	TEXT UNIQUE NOT NULL,
        ts BIGINT NOT NULL
    );
    `);
}
