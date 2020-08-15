import { IrcServer } from "../irc/IrcServer";
import { IrcBridge } from "./IrcBridge";
import { MatrixRoom, Intent } from "matrix-appservice-bridge";
import { BridgeRequest } from "../models/BridgeRequest";
import { RoomOrigin } from "../datastore/DataStore";
import { IrcRoom } from "../models/IrcRoom";

interface TrackChannelOpts {
    server: IrcServer;
    ircChannel: string;
    key?: string;
    inviteList?: string[];
    origin: RoomOrigin;
    roomAliasName?: string;
    intent?: Intent;
    roomVisibility?: "public"|"private";
    historyVisiblity?: "joined"|"invited"|"shared"|"world_readable";
    shouldTrack?: boolean;
}

/**
 * Track an IRC channel and create a room for it.
 * @param ircBridge The ircBridge instance
 * @param req The request that triggered the room creation
 * @param opts Information about the room creation request.
 */
export async function trackChannelAndCreateRoom(ircBridge: IrcBridge, req: BridgeRequest, opts: TrackChannelOpts) {
    if (opts.shouldTrack === undefined) {
        opts.shouldTrack = true;
    }
    let ircRoom: IrcRoom;
    const { server, ircChannel, key, inviteList, origin, roomAliasName, shouldTrack } = opts;
    const intent = opts.intent || ircBridge.getAppServiceBridge().getIntent();
    const initialState: ({type: string; state_key: string; content: object})[] = [
        {
            type: "m.room.join_rules",
            state_key: "",
            content: {
                join_rule: server.getJoinRule()
            }
        },
        {
            type: "m.room.history_visibility",
            state_key: "",
            content: {
                history_visibility: opts.historyVisiblity || "joined"
            }
        }
    ];
    if (server.areGroupsEnabled()) {
        initialState.push({
            type: "m.room.related_groups",
            state_key: "",
            content: {
                groups: [server.getGroupId()],
            }
        });
    }
    if (ircBridge.stateSyncer) {
        initialState.push(
            ircBridge.stateSyncer.createInitialState(
                server,
                ircChannel,
            )
        )
    }
    if (shouldTrack) {
        req.log.info("Going to track IRC channel %s", ircChannel);
        ircRoom = await ircBridge.trackChannel(server, ircChannel, key);
        req.log.info("Bot is now tracking IRC channel.");
    }
    else {
        ircRoom = new IrcRoom(server, ircChannel);
    }
    let roomId;
    try {
        const response = await intent.createRoom({
            options: {
                name: ircChannel,
                visibility: opts.roomVisibility || "private",
                preset: "public_chat",
                creation_content: {
                    "m.federate": server.shouldFederate()
                },
                room_alias_name: roomAliasName,
                initial_state: initialState,
                invite: inviteList,
                room_version: server.forceRoomVersion(),
            }
        });
        roomId = response.room_id;
        req.log.info("Matrix room %s created.", roomId);
    }
    catch (ex) {
        req.log.error("Failed to create room: %s", ex.stack);
        throw ex;
    }

    const mxRoom = new MatrixRoom(roomId);
    await ircBridge.getStore().storeRoom(ircRoom, mxRoom, origin);
    if (shouldTrack) {
        // /mode the channel AFTER we have created the mapping so we process
        // +s and +i correctly. This is done asyncronously.
        ircBridge.publicitySyncer.initModeForChannel(server, ircChannel).catch(() => {
            req.log.error(
                `Could not init mode for channel ${ircChannel} on ${server.domain}`
            );
        });
    }
    return { ircRoom, mxRoom };
}
