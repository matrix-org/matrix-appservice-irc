import { PoolClient } from "pg";

export async function runSchema(connection: PoolClient) {
    // Create schema
    await connection.query(`
    `);
}
import { SchemaUpdateFunction } from 'matrix-appservice-bridge';

const updateFn: SchemaUpdateFunction = async (sql) => {
    // Create schema
    await sql`
    CREATE TABLE last_seen (
        user_id	TEXT UNIQUE NOT NULL,
        ts BIGINT NOT NULL
    );`;

};

export default updateFn;
