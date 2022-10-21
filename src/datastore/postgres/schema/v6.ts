import { SchemaUpdateFunction } from 'matrix-appservice-bridge';

const updateFn: SchemaUpdateFunction = async (sql) => {
    await sql`DROP INDEX client_config_domain_username_idx;`
};

export default updateFn;
