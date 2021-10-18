import { PoolClient } from "pg";

export async function runSchema(connection: PoolClient) {
    await connection.query(`
    CREATE TABLE user_activity (
        user_id TEXT UNIQUE,
        data JSON
    );
    `);
}
