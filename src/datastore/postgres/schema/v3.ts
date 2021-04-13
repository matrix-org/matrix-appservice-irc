import { PoolClient } from "pg";

export async function runSchema(connection: PoolClient) {
    // Create schema
    await connection.query(`
    CREATE TABLE room_visibility (
        room_id	TEXT UNIQUE NOT NULL,
        visibility BOOLEAN NOT NULL
    );
    `);
}
