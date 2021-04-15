import NeDB from "nedb";
import nopt from "nopt";
import path from "path";
import { promises as fs } from "fs";
import { simpleLogger } from "../logging";
import { promisify } from "util";
import { PgDataStore } from "../datastore/postgres/PgDataStore";
import { IrcRoom } from "../models/IrcRoom";
import { MatrixRoom, MatrixUser } from "matrix-appservice-bridge";
import { IrcClientConfig } from "../models/IrcClientConfig";

const log = simpleLogger();

// NeDB is schemaless
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type promisfiedFind = (params: any) => Promise<any[]>;

async function migrate(roomsFind: promisfiedFind, usersFind: promisfiedFind, pgStore: PgDataStore,
                       typesToRun: string[]) {
    const migrateChannels = async () => {
        const channelEntries = await roomsFind({ "remote.type": "channel" });
        log.info(`Migrating ${channelEntries.length} channels`);

        for (const entry of channelEntries) {
            if (entry.id.startsWith("PM")) {
                continue; // Some entries are mis-labeled as channels when they are PMs
            }
            try {
                await pgStore.upsertRoom(
                    entry.data.origin,
                    "channel",
                    entry.remote.domain,
                    entry.remote.channel,
                    entry.matrix_id,
                    JSON.stringify(entry.remote),
                    JSON.stringify(entry.matrix),
                );
                log.info(`Migrated channel ${entry.remote.channel}`);
            }
            catch (ex) {
                log.error(`Failed to migrate channel ${entry.remote.channel} ${ex.message}`);
                log.error(JSON.stringify(entry));
                throw ex;
            }
        }
        log.info("Migrated channels");
    }

    const migrateCounter = async () => {
        log.info(`Migrating ipv6 counter`);
        const counterEntry = await usersFind({ "type": "remote", "id": "config" });
        if (counterEntry.length && counterEntry[0].data && counterEntry[0].data.ipv6_counter) {
            await pgStore.setIpv6Counter(counterEntry[0].data.ipv6_counter);
        }
        else {
            log.info("No ipv6 counter found");
        }
        log.info("Migrated ipv6 counter");
    }

    const migrateAdminRooms = async () => {
        const entries = await roomsFind({ "matrix.extras.admin_id": { $exists: true } });
        log.info(`Migrating ${entries.length} admin rooms`);
        for (const entry of entries) {
            await pgStore.storeAdminRoom(
                new MatrixRoom(entry.matrix_id),
                entry.matrix.extras.admin_id,
            );
        }
        log.info("Migrated admin rooms");
    }

    const migrateUserFeatures = async () => {
        const entries = await usersFind({ "type": "matrix", "data.features": { $exists: true } });
        log.info(`Migrating ${entries.length} user features`);
        for (const entry of entries) {
            await pgStore.storeUserFeatures(
                entry.id,
                entry.data.features,
            );
        }
        log.info("Migrated user features");
    }

    const migrateUserConfiguration = async () => {
        const entries = await usersFind({ "type": "matrix", "data.client_config": { $exists: true } });
        log.info(`Migrating ${entries.length} user configs`);
        for (const entry of entries) {
            const configs = entry.data.client_config;
            for (const network of Object.keys(configs)) {
                const config = configs[network];
                const password = config.password;
                delete config.password; // We store this seperate now.
                await pgStore.storeIrcClientConfig(new IrcClientConfig(entry.id, network, config));
                await pgStore.storePass(entry.id, network, password, false);
            }
            await pgStore.storeUserFeatures(
                entry.id,
                entry.data.features,
            );
        }
        log.info("Migrated user configs");
    }

    const migrateUsers = async () => {
        const entries = await usersFind({ "type": "matrix" });
        log.info(`Migrating ${entries.length} users`);
        for (const entry of entries) {
            // We store these seperately.
            delete entry.data.client_config;
            delete entry.data.features;
            await pgStore.storeMatrixUser(
                new MatrixUser(entry.id, entry.data)
            );
        }
        log.info("Migrated users");
    }

    const migratePMs = async () => {
        const entries = await roomsFind({ "remote.type": "pm" });
        log.info(`Migrating ${entries.length} PM rooms`);
        for (const entry of entries.reverse()) {
            // We previously allowed unlimited numbers of PM rooms, but the bridge now mandates
            // that only one DM room may exist for a given mxid<->nick. Reverse the entries, and
            // ignore any future collisions to ensure that we only use the latest.
            try {
                await pgStore.setPmRoom(
                    // IrcRoom will only ever use the domain property
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    new IrcRoom({ domain: entry.remote.domain } as any, entry.remote.channel),
                    new MatrixRoom(entry.matrix_id),
                    entry.data.real_user_id,
                    entry.data.virtual_user_id,
                );
            }
            catch (ex) {
                log.warn("Not migrating %s", entry.matrix_id);
            }
        }
        log.info("Migrated PMs");
    }

    if (typesToRun.includes("channels")) {
        await migrateChannels();
    }
    if (typesToRun.includes("counter")) {
        await migrateCounter();
    }
    if (typesToRun.includes("adminrooms")) {
        await migrateAdminRooms();
    }
    if (typesToRun.includes("features")) {
        await migrateUserFeatures();
    }
    if (typesToRun.includes("config")) {
        await migrateUserConfiguration();
    }
    if (typesToRun.includes("users")) {
        await migrateUsers();
    }
    if (typesToRun.includes("pms")) {
        await migratePMs();
    }
}

async function main() {
    const opts = nopt({
        dbdir: path,
        connectionString: String,
        verbose: Boolean,
        privateKey: path,
        types: Array,
    },
    {
        f: "--dbdir",
        c: "--connectionString",
        p: "--privateKey",
        v: "--verbose",
        t: "--types",
    }, process.argv, 2);

    const typesToRun = opts.types || ["channels", "counter", "adminrooms", "features", "config", "users", "pms"];

    if (opts.dbdir === undefined || opts.connectionString === undefined) {
        log.error("Missing --dbdir or --connectionString or --domain");
        process.exit(1);
    }

    if (opts.privateKey === undefined) {
        log.warn("Missing privateKey, passwords will not be migrated");
    }

    if (opts.verbose) {
        log.level = "verbose";
    }

    try {
        await Promise.all(["rooms.db", "users.db"].map(async f => {
            const p = path.join(opts.dbdir, f);
            const stats = await fs.stat(p);
            if (stats.isDirectory() && stats.size > 0) {
                throw Error(`${p} must be a file`);
            }
        }));
    }
    catch (ex) {
        log.error("Missing a file: %s", ex);
        process.exit(1);
    }

    // Domain isn't used for any of our operations
    const pgStore = new PgDataStore("", opts.connectionString, opts.privateKey);

    try {
        await pgStore.ensureSchema();
    }
    catch (ex) {
        log.warn("Could not ensure schema version: %s", ex);
        process.exit(1);
    }

    const rooms = new NeDB({ filename: path.join(opts.dbdir, "rooms.db"), autoload: true });
    const users = new NeDB({ filename: path.join(opts.dbdir, "users.db"), autoload: true });

    const roomsFind = promisify(rooms.find).bind(rooms) as promisfiedFind;
    const usersFind = promisify(users.find).bind(users) as promisfiedFind;

    const time = Date.now();
    log.info("Starting migration");
    await migrate(roomsFind, usersFind, pgStore, typesToRun);
    log.info("Finished migration at %sms", Date.now() - time);
}

main().catch((ex) => {
    log.error("Failed to run migration script: %s", ex);
})
