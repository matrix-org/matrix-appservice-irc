/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Request } from "matrix-appservice-bridge";
import { IrcBridge } from "../../lib/bridge/IrcBridge";
import { BridgeRequest } from "../../lib/models/BridgeRequest";
import envBundle from "../util/env-bundle";

describe("Publicity Syncing", function() {
    const {env, roomMapping, test} = envBundle();

    beforeEach(async () => {
        await test.beforeEach(env);

        env.ircMock._autoConnectNetworks(
            roomMapping.server, roomMapping.botNick, roomMapping.server
        );
        env.ircMock._autoJoinChannels(
            roomMapping.server, roomMapping.botNick, roomMapping.channel
        );

        await test.initEnv(env);
    });

    afterEach(async () => test.afterEach(env));

    it("should ensure rooms with no visibility state are private", async () => {
        const ircBridge: IrcBridge = env.ircBridge as IrcBridge;
        const store = ircBridge.getStore();
        const roomVis = await store.getRoomsVisibility([roomMapping.roomId]);
        expect(roomVis.get(roomMapping.roomId)).toBe('private');
    });

    it("should ensure rooms with +s channels are set to private visibility", async () => {
        const ircBridge: IrcBridge = env.ircBridge as IrcBridge;
        const store = ircBridge.getStore();
        // Ensure opposite state
        await store.setRoomVisibility(roomMapping.roomId, "public");
        const req = new BridgeRequest(new Request({
            data: {
                isFromIrc: true,
            }
        }));
        const server = ircBridge.getServer(roomMapping.server)!;
        await ircBridge.ircHandler.roomAccessSyncer.onMode(
            req, server, roomMapping.channel, "", "s", true, null
        );
        const roomVis = await store.getRoomsVisibility([roomMapping.roomId]);
        expect(roomVis.get(roomMapping.roomId)).toBe('private');
    });

    it("should ensure rooms with -s channels are set to public visibility", async () => {
        const ircBridge: IrcBridge = env.ircBridge as IrcBridge;
        const store = ircBridge.getStore();
        const req = new BridgeRequest(new Request({
            data: {
                isFromIrc: true,
            }
        }));
        const server = ircBridge.getServer(roomMapping.server)!;
        await ircBridge.ircHandler.roomAccessSyncer.onMode(
            req, server, roomMapping.channel, "", "s", false, null
        );
        const roomVis = await store.getRoomsVisibility([roomMapping.roomId]);
        expect(roomVis.get(roomMapping.roomId)).toBe('public');
    });
});
