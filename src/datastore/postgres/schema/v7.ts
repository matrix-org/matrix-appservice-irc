import { SchemaUpdateFunction } from 'matrix-appservice-bridge';

const updateFn: SchemaUpdateFunction = async (sql) => {
    await sql`
    CREATE TABLE user_activity (
        user_id TEXT UNIQUE,
        data JSON
    );`
};

export default updateFn;
