import { SchemaUpdateFunction } from 'matrix-appservice-bridge';

const updateFn: SchemaUpdateFunction = async (sql) => {
    await sql`
    CREATE TABLE room_visibility (
        room_id	TEXT UNIQUE NOT NULL,
        visibility BOOLEAN NOT NULL
    );`
};

export default updateFn;
