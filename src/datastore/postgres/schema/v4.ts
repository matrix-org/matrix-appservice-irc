import { SchemaUpdateFunction } from 'matrix-appservice-bridge';

const updateFn: SchemaUpdateFunction = async (sql) => {
    await sql`
    CREATE TABLE deactivated_users (
        user_id	TEXT UNIQUE NOT NULL,
        ts BIGINT NOT NULL
    );`
};

export default updateFn;
