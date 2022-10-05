import { SchemaUpdateFunction } from 'matrix-appservice-bridge';

const updateFn: SchemaUpdateFunction = async (sql) => {
    await sql`CREATE INDEX client_config_domain_username_idx ON client_config (domain, (config->>'username'));`
};

export default updateFn;
