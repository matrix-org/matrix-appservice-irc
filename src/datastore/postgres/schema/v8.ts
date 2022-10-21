import { Logger, SchemaUpdateFunction } from "matrix-appservice-bridge";

const log = new Logger('postgres/schema/v8');

const updateFn: SchemaUpdateFunction = async (sql) => {
    await sql`
        ALTER TABLE ipv6_counter
        ADD COLUMN homeserver TEXT,
        ADD COLUMN server TEXT;
        ALTER TABLE ipv6_counter
        ADD CONSTRAINT cons_ipv6_counter_unique UNIQUE(homeserver, server);
    `;

    // Migrate data.
    const existingCounterRes = await sql<{count: string}[]>`SELECT count FROM ipv6_counter;`;
    const existingCounter = existingCounterRes && parseInt(existingCounterRes?.[0].count, 10);

    // If we have a counter value
    if (existingCounter) {
        const serverConfigsRes = await sql<{domain: string}[]>`
            SELECT DISTINCT domain FROM client_config WHERE config->>'ipv6' IS NOT NULL;
        `;
        if (serverConfigsRes?.length === 0) {
            // No servers to migrate?
            throw Error("No client_configs found with ipv6 addresses, but counter was found");
        }
        else if (serverConfigsRes?.length > 1) {
            log.warn("More than one IPv6 server configured, starting both ipv6 counters from the same value.");
        }
        // Because we cannot determine which IRC network(s) are using the existing counter
        // (owing to a bug where we treated the counter as global across all networks), this assumes
        // that both networks start from the same counter value.
        const domains = serverConfigsRes.flatMap(r => ({
            count: existingCounter,
            domain: r.domain,
            homeserver: '*'
        }));
        await sql`INSERT INTO ipv6_counter ${sql(domains, 'count', 'domain', 'homeserver')})`;
    }

    await sql`
        DELETE FROM ipv6_counter WHERE server IS NULL;
        ALTER TABLE ipv6_counter ALTER COLUMN server SET NOT NULL;
    `;
};

export default updateFn;
