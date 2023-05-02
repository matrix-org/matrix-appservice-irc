import {PoolClient} from "pg";

export async function runSchema(connection: PoolClient) {
    await connection.query(`
    CREATE TABLE provisioner_sessions (
        user_id TEXT,
        token TEXT UNIQUE,
        expires_ts BIGINT
    );`
    );
}
