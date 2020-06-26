import { IrcServer } from "../irc/IrcServer";
import { IrcBridge } from "./IrcBridge";
import { MatrixRoom } from "matrix-appservice-bridge";
import { BridgeRequest } from "../models/BridgeRequest";

interface CreateRoomOpts {
    server: IrcServer;
    ircChannel: string;
    key?: string;
    inviteList: string[];
}

export async function createAndTrackRoom(ircBridge: IrcBridge, req: BridgeRequest, opts: CreateRoomOpts) {
    const { server, ircChannel, key, inviteList } = opts;
    const initialState: unknown[] = [
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
                history_visibility: "joined"
            }
        }
    ];
    if (server.areGroupsEnabled()) {
        initialState.push({
            type: "m.room.related_groups",
            state_key: "",
            content: {
                groups: [server.getGroupId() as string]
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
    const ircRoom = await ircBridge.trackChannel(server, ircChannel, key);
    const response = await ircBridge.getAppServiceBridge().getIntent().createRoom({
        options: {
            name: ircChannel,
            visibility: "private",
            preset: "public_chat",
            creation_content: {
                "m.federate": server.shouldFederate()
            },
            initial_state: initialState,
            invite: inviteList,
        }
    });
    const mxRoom = new MatrixRoom(response.room_id);
    await ircBridge.getStore().storeRoom(ircRoom, mxRoom, 'join');
    // /mode the channel AFTER we have created the mapping so we process
    // +s and +i correctly. This is done asyncronously.
    ircBridge.publicitySyncer.initModeForChannel(server, ircChannel).catch(() => {
        req.log.error(
            `Could not init mode for channel ${ircChannel} on ${server.domain}`
        );
    });
    return { ircRoom, mxRoom };
}
