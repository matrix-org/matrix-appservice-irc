import { PoolClient } from "pg";

export async function runSchema(connection: PoolClient) {
    // Create schema
    await connection.query(`
    CREATE TABLE schema (
        version	INTEGER UNIQUE NOT NULL
    );

    INSERT INTO schema VALUES (0);

    CREATE TABLE rooms (
        origin TEXT NOT NULL,
        room_id TEXT NOT NULL,
        type TEXT NOT NULL,
        irc_domain TEXT NOT NULL,
        irc_channel TEXT NOT NULL,
        irc_json JSON NOT NULL,
        matrix_json JSON NOT NULL,
        CONSTRAINT cons_rooms_unique UNIQUE(room_id, irc_domain, irc_channel)
    );

    CREATE INDEX rooms_roomid_idx ON rooms (room_id);
    CREATE INDEX rooms_ircdomainchannel_idx ON rooms (irc_domain, irc_channel);

    CREATE TABLE admin_rooms (
        room_id TEXT UNIQUE,
        user_id TEXT
    );

    CREATE TABLE pm_rooms (
        room_id TEXT UNIQUE,
        irc_domain TEXT NOT NULL,
        irc_nick TEXT NOT NULL,
        matrix_user_id TEXT,
        virtual_user_id TEXT,
        CONSTRAINT cons_pm_rooms_matrix_irc_unique UNIQUE(matrix_user_id, irc_domain, irc_nick)
    );

    CREATE TABLE matrix_users (
        user_id TEXT UNIQUE,
        data JSON
    );

    CREATE TABLE client_config (
        user_id TEXT,
        domain TEXT NOT NULL,
        config JSON,
        password TEXT,
        CONSTRAINT cons_client_config_unique UNIQUE(user_id, domain)
    );

    CREATE TABLE user_features (
        user_id TEXT UNIQUE,
        features JSON
    );

    CREATE TABLE ipv6_counter (
        count INTEGER
    );

    INSERT INTO ipv6_counter VALUES (0);`);
}
