import {PoolClient} from "pg";

export async function runSchema(connection: PoolClient) {
    await connection.query(`
    ALTER TABLE client_config
        ADD COLUMN cert TEXT,
        ADD COLUMN key TEXT;`
    );
}
