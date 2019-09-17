import { IDatabase } from "pg-promise";

// tslint:disable-next-line: no-any
export async function runSchema(db: IDatabase<any>) {
    // Create schema
    await db.none(`
    CREATE TABLE schema (
        version	INTEGER UNIQUE NOT NULL
    );

    INSERT INTO schema VALUES (0);

    CREATE TABLE rooms (
        origin TEXT,
        room_id TEXT,
        type TEXT,
        irc_domain TEXT,
        irc_channel TEXT,
        irc_json JSON,
        matrix_json JSON,
        CONSTRAINT cons_rooms_unique UNIQUE(irc_domain, irc_channel, room_id)
    );

    CREATE UNIQUE INDEX rooms_roomid_idx ON rooms (room_id);
    CREATE UNIQUE INDEX rooms_ircdomainchannel_idx ON rooms (irc_domain, irc_channel);
    CREATE UNIQUE INDEX rooms_ircdomainchannelroomid_idx ON rooms (irc_domain, irc_channel, room_id);

    CREATE TABLE admin_rooms (
        room_id TEXT UNIQUE,
        user_id TEXT
    );

    CREATE UNIQUE INDEX admin_rooms_room_id_idx ON admin_rooms (room_id);
    CREATE UNIQUE INDEX admin_rooms_user_id_idx ON admin_rooms (user_id);

    CREATE TABLE matrix_users (
        user_id TEXT UNIQUE,
        data TEXT
    );

    CREATE TABLE client_config (
        user_id TEXT UNIQUE,
        domain TEXT NOT NULL,
        config TEXT,
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
