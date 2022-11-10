import { PoolClient } from "pg";

export async function runSchema(connection: PoolClient) {
    await connection.query(`
        ALTER TABLE last_seen ADD COLUMN first BIGINT;
        ALTER TABLE last_seen RENAME COLUMN ts TO last;
        UPDATE last_seen SET first = last;
        ALTER TABLE last_seen ALTER COLUMN first SET NOT NULL;
    `);
}
