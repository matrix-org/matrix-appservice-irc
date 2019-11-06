/*
Copyright 2019 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { BridgeRequest } from "../models/BridgeRequest";
import { MatrixRoom, MatrixUser } from "matrix-appservice-bridge";
import { IrcBridge } from "./IrcBridge";
import { MatrixAction } from "../models/MatrixAction";
import { IrcServer } from "../irc/IrcServer";
import { BridgedClient } from "../irc/BridgedClient";
import { IrcClientConfig } from "../models/IrcClientConfig";
import { MatrixHandler } from "./MatrixHandler";
import logging from "../logging";

const log = logging("AdminRoomHandler");

let BridgeVersion = "unknown";

try {
    BridgeVersion = require("../../package.json").version;
}
catch (err) {
    log.error("Couldn't get `version` from package.json");
}

const COMMANDS = {
    "!join": {
        example: `!join [irc.example.net] #channel [key]`,
        summary: `Join a channel (with optional channel key)`,
    },
    "!cmd": {
        example: `!cmd [irc.example.net] COMMAND [arg0 [arg1 [...]]]`,
        summary: "Issue a raw IRC command. These will not produce a reply." +
                "(Note that the command must be all uppercase.)",
    },
    "!whois": {
        example: `!whois [irc.example.net] NickName|@alice:matrix.org`,
        summary: "Do a /whois lookup. If a Matrix User ID is supplied, " +
                "return information about that user's IRC connection.",
    },
    "!storepass": {
        example: `!storepass [irc.example.net] passw0rd`,
        summary: `Store a NickServ password (server password)`,
    },
    "!removepass": {
        example: `!removepass [irc.example.net]`,
        summary: `Remove a previously stored NickServ password`,
    },
    "!quit": {
        example: `!quit`,
        summary: "Leave all bridged channels, on all networks, and remove your " +
                "connections to all networks.",
    },
    "!nick": {
        example: `!nick [irc.example.net] DesiredNick`,
        summary: "Change your nick. If no arguments are supplied, " +
                "your current nick is shown.",
    },
    "!feature": {
        example: `!feature feature-name [true/false/default]`,
        summary: `Enable, disable or default a feature's status for your account.` +
                `Will display the current feature status if true/false/default not given.`,
    },
    "!bridgeversion": {
        example: `!bridgeversion`,
        summary: "Return the version from matrix-appservice-irc bridge.",
    }
};

const USER_FEATURES = ["mentions"];

interface MatrixSimpleMessage {
    sender: string;
    content: {
        body: string;
    };
}

export class AdminRoomHandler {
    private readonly botUser: MatrixUser;
    constructor(private ircBridge: IrcBridge, private matrixHandler: MatrixHandler) {
        this.botUser = new MatrixUser(ircBridge.appServiceUserId, undefined, false);

    }

    public async onAdminMessage(req: BridgeRequest, event: MatrixSimpleMessage, adminRoom: MatrixRoom) {
        req.log.info("Handling command from %s", event.sender);
        // Assumes all commands have the form "!wxyz [irc.server] [args...]"
        const segments = event.content.body.split(" ");
        const cmd = segments.shift();
        const args = segments;

        // Work out which IRC server the command is directed at.
        const clientList = this.ircBridge.getBridgedClientsForUserId(event.sender);
        let ircServer = this.ircBridge.getServer(args[0]);

        if (ircServer) {
            args.shift(); // pop the server so commands don't need to know
        }
        else {
            // default to the server the client is connected to if there is only one
            if (clientList.length === 1) {
                ircServer = clientList[0].server;
            }
            // default to the only server we know about if we only bridge 1 thing.
            else if (this.ircBridge.getServers().length === 1) {
                ircServer = this.ircBridge.getServers()[0];
            }
            else {
                const notice = new MatrixAction("notice",
                    "A server address must be specified."
                );
                await this.ircBridge.sendMatrixAction(adminRoom, this.botUser, notice);
                return;
            }
        }

        switch (cmd) {
            case "!join":
                await this.handleJoin(req, args, ircServer, adminRoom, event.sender);
                break;
            case "!cmd":
                await this.handleCmd(req, args, ircServer, adminRoom, event.sender);
                break;
            case "!whois":
                await this.handleWhois(req, args, ircServer, adminRoom, event.sender);
                break;
            case "!storepass":
                await this.handleStorePass(req, args, ircServer, adminRoom, event.sender, clientList[0]);
                break;
            case "!removepass":
                await this.handleRemovePass(ircServer, adminRoom, event.sender);
                break;
            case "!quit":
                await this.handleQuit(req, event.sender, ircServer, adminRoom, clientList);
                break;
            case "!nick":
                await this.handleNick(req, args, ircServer, clientList, adminRoom, event.sender);
                break;
            case "!feature":
                await this.handleFeature(args, adminRoom, event.sender);
                break;
            case "!bridgeversion":
                await this.showBridgeVersion(adminRoom);
                break;
            case "!help":
                await this.showHelp(adminRoom);
                break;
            default:
                const notice = new MatrixAction("notice",
                "The command was not recognised. Available commands are listed by !help");
                await this.ircBridge.sendMatrixAction(adminRoom, this.botUser, notice);
                break;
        }
    }

    private async handleJoin(req: BridgeRequest, args: string[], server: IrcServer, room: MatrixRoom, sender: string) {
        // TODO: Code dupe from !nick
        // Format is: "!join irc.example.com #channel [key]"

        // check that the server exists and that the user_id is on the whitelist
        const ircChannel = args[0];
        const key = args[1]; // keys can't have spaces in them, so we can just do this.
        let errText = null;
        if (!ircChannel || ircChannel.indexOf("#") !== 0) {
            errText = "Format: '!join irc.example.com #channel [key]'";
        }
        else if (server.hasInviteRooms() && !server.isInWhitelist(sender)) {
            errText = "You are not authorised to join channels on this server.";
        }

        if (errText) {
            await this.ircBridge.sendMatrixAction(
                room, this.botUser, new MatrixAction("notice", errText)
            );
            return;
        }
        req.log.info("%s wants to join the channel %s on %s", sender, ircChannel, server.domain);

        // There are 2 main flows here:
        //   - The !join is instigated to make the BOT join a new channel.
        //        * Bot MUST join and invite user
        //   - The !join is instigated to make the USER join a new channel.
        //        * IRC User MAY have to join (if bridging incr joins or using a chan key)
        //        * Bot MAY invite user
        //
        // This means that in both cases:
        //  1) Bot joins IRC side (NOP if bot is disabled)
        //  2) Bot sends Matrix invite to bridged room. (ignore failures if already in room)
        // And *sometimes* we will:
        //  3) Force join the IRC user (if given key / bridging joins)

        // track the channel if we aren't already
        const matrixRooms = await this.ircBridge.getStore().getMatrixRoomsForChannel(
            server, ircChannel
        );

        if (matrixRooms.length === 0) {
            // track the channel then invite them.
            // TODO: Dupes onAliasQuery a lot
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
            const ircRoom = await this.ircBridge.trackChannel(server, ircChannel, key);
            const response = await this.ircBridge.getAppServiceBridge().getIntent(
                sender,
            ).createRoom({
                options: {
                    name: ircChannel,
                    visibility: "private",
                    preset: "public_chat",
                    creation_content: {
                        "m.federate": server.shouldFederate()
                    },
                    initial_state: initialState,
                }
            });
            const mxRoom = new MatrixRoom(response.room_id);
            await this.ircBridge.getStore().storeRoom(ircRoom, mxRoom, 'join');
            // /mode the channel AFTER we have created the mapping so we process
            // +s and +i correctly.
            this.ircBridge.publicitySyncer.initModeForChannel(server, ircChannel).catch(() => {
                log.error(
                    `Could not init mode for channel ${ircChannel} on ${server.domain}`
                );
            });
            req.log.info(
                "Created a room to track %s on %s and invited %s",
                ircRoom.channel, server.domain, sender
            );
            matrixRooms.push(mxRoom);
        }

        // already tracking channel, so just invite them.
        const invitePromises = matrixRooms.map((r) => {
            req.log.info(
                "Inviting %s to room %s", sender, r.getId()
            );
            return this.ircBridge.getAppServiceBridge().getIntent().invite(
                room.getId(), sender
            );
        });
        for (const r of matrixRooms) {
            const userMustJoin = (
                key || server.shouldSyncMembershipToIrc("incremental", r.getId())
            );
            if (!userMustJoin) {
                continue;
            }
            const bc = await this.ircBridge.getBridgedClient(
                server, sender
            );
            await bc.joinChannel(ircChannel, key);
            break;
        }
        // check whether we should be force joining the IRC user
        for (let i = 0; i < matrixRooms.length; i++) {
            const m = matrixRooms[i];
            const userMustJoin = (
                key || server.shouldSyncMembershipToIrc("incremental", m.getId())
            );
            if (userMustJoin) {
                // force join then break out (we only ever join once no matter how many
                // rooms the channel is bridged to)
                const bc = await this.ircBridge.getBridgedClient(
                    server, sender
                );
                await bc.joinChannel(ircChannel, key);
                break;
            }
        }

        await Promise.all(invitePromises);
    }

    private async handleCmd(req: BridgeRequest, args: string[], server: IrcServer, room: MatrixRoom, sender: string) {
        req.log.info(`No valid (old form) admin command, will try new format`);

        // Assumes commands have the form
        // !cmd [irc.server] COMMAND [arg0 [arg1 [...]]]

        const blacklist = ['PROTOCTL'];

        try {
            const keyword = args[0];

            // keyword could be a failed server or a malformed command
            if (!keyword.match(/^[A-Z]+$/)) {
                // if not a domain OR is only word (which implies command)
                if (!keyword.match(/^[a-z0-9:\.-]+$/) || args.length == 1) {
                    throw new Error(`Malformed command: ${keyword}`);
                }
                else {
                    throw new Error(`Domain not accepted: ${keyword}`);
                }
            }

            if (blacklist.indexOf(keyword) != -1) {
                throw new Error(`Command blacklisted: ${keyword}`);
            }

            // If no args after COMMAND, this will be []
            const sendArgs = args.splice(1);
            sendArgs.unshift(keyword);

            const bridgedClient = await this.ircBridge.getBridgedClient(
                server, sender
            );

            if (!bridgedClient.unsafeClient) {
                throw new Error('Possibly disconnected');
            }

            bridgedClient.unsafeClient.send(...sendArgs);
        }
        catch (err) {
            const notice = new MatrixAction("notice", `${err}\n` );
            await this.ircBridge.sendMatrixAction(room, this.botUser, notice);
            return;
        }
    }

    private async handleWhois(req: BridgeRequest, args: string[], server: IrcServer, room: MatrixRoom, sender: string) {
        // Format is: "!whois <nick>"

        const whoisNick = args.length === 1 ? args[0] : null; // ensure 1 arg
        if (!whoisNick) {
            await this.ircBridge.sendMatrixAction(
                room, this.botUser,
                new MatrixAction("notice", "Format: '!whois nick|mxid'")
            );
            return;
        }

        if (whoisNick[0] === "@") {
            // querying a Matrix user - whoisNick is the matrix user ID
            req.log.info("%s wants whois info on %s", sender, whoisNick);
            const whoisClient = this.ircBridge.getIrcUserFromCache(server, whoisNick);
            try {
                const noticeRes = new MatrixAction(
                    "notice",
                    whoisClient ?
                    `${whoisNick} is connected to ${server.domain} as '${whoisClient.nick}'.` :
                    `${whoisNick} has no IRC connection via this bridge.`);
                await this.ircBridge.sendMatrixAction(room, this.botUser, noticeRes);
            }
            catch (err) {
                if (err.stack) {
                    req.log.error(err);
                }
                const noticeErr = new MatrixAction("notice", "Failed to perform whois query.");
                await this.ircBridge.sendMatrixAction(room, this.botUser, noticeErr);
            }
            return;
        }

        req.log.info("%s wants whois info on %s on %s", sender,
            whoisNick, server.domain);
        const bridgedClient = await this.ircBridge.getBridgedClient(server, sender);
        try {
            const response = await bridgedClient.whois(whoisNick);
            const noticeRes = new MatrixAction("notice", response.msg);
            await this.ircBridge.sendMatrixAction(room, this.botUser, noticeRes);
        }
        catch (err) {
            if (err.stack) {
                req.log.error(err);
            }
            const noticeErr = new MatrixAction("notice", err.message);
            await this.ircBridge.sendMatrixAction(room, this.botUser, noticeErr);
        }
    }

    private async handleStorePass(req: BridgeRequest, args: string[], server: IrcServer,
        room: MatrixRoom, userId: string, client: BridgedClient) {
        const domain = server.domain;
        let notice;

        try {
            // Allow passwords with spaces
            const pass = args.join(' ');
            if (pass.length === 0) {
                notice = new MatrixAction(
                    "notice",
                    "Format: '!storepass password' " +
                    "or '!storepass irc.server.name password'\n"
                );
            }
            else {
                await this.ircBridge.getStore().storePass(userId, domain, pass);
                notice = new MatrixAction(
                    "notice", `Successfully stored password for ${domain}. You will now be reconnected to IRC.`
                );
            }
            if (client) {
                await client.disconnect("iwantoreconnect", "authenticating", false);
            }
        }
        catch (err) {
            notice = new MatrixAction(
                "notice", `Failed to store password: ${err.message}`
            );
            req.log.error(err.stack);
        }

        await this.ircBridge.sendMatrixAction(room, this.botUser, notice);
    }

    private async handleRemovePass(ircServer: IrcServer, adminRoom: MatrixRoom, userId: string) {
        const domain = ircServer.domain;
        let notice;

        try {
            await this.ircBridge.getStore().removePass(userId, domain);
            notice = new MatrixAction(
                "notice", `Successfully removed password.`
            );
        }
        catch (err) {
            notice = new MatrixAction(
                "notice", `Failed to remove password: ${err.message}`
            );
        }

        await this.ircBridge.sendMatrixAction(adminRoom, this.botUser, notice);
    }

    private async handleQuit(req: BridgeRequest, sender: string, server: IrcServer,
        room: MatrixRoom, clients: BridgedClient[]) {
        const msgText = await this.matrixHandler.quitUser(
            req, sender, clients, server, "issued !quit command"
        );
        if (msgText) {
            const notice = new MatrixAction("notice", msgText);
            await this.ircBridge.sendMatrixAction(room, this.botUser, notice);
        }
    }

    private async handleNick(req: BridgeRequest, args: string[], ircServer: IrcServer, clientList: BridgedClient[],
        adminRoom: MatrixRoom, sender: string) {
        // Format is: "!nick irc.example.com NewNick"
        if (!ircServer.allowsNickChanges()) {
            const notice = new MatrixAction("notice",
                "Server " + ircServer.domain + " does not allow nick changes."
            );
            await this.ircBridge.sendMatrixAction(adminRoom, this.botUser, notice);
            return;
        }

        const nick = args.length === 1 ? args[0] : null; // make sure they only gave 1 arg
        if (!ircServer || !nick) {
            let connectedNetworksStr = "";
            if (clientList.length === 0) {
                connectedNetworksStr = (
                    "You are not currently connected to any " +
                    "IRC networks which have nick changes enabled."
                );
            }
            else {
                connectedNetworksStr = "Currently connected to IRC networks:\n";
                for (let i = 0; i < clientList.length; i++) {
                    connectedNetworksStr += clientList[i].server.domain +
                        " as " + clientList[i].nick + "\n";
                }
            }
            const notice = new MatrixAction("notice",
                "Format: '!nick DesiredNick' or '!nick irc.server.name DesiredNick'\n" +
                connectedNetworksStr
            );
            await this.ircBridge.sendMatrixAction(adminRoom, this.botUser, notice);
            return;
        }
        req.log.info("%s wants to change their nick on %s to %s",
            sender, ircServer.domain, nick);

        if (ircServer.claimsUserId(sender)) {
            req.log.error("%s is a virtual user!", sender);
            return;
        }

        // change the nick
        const bridgedClient = await this.ircBridge.getBridgedClient(ircServer, sender);
        try {
            if (bridgedClient) {
                const response = await bridgedClient.changeNick(nick, true);
                const noticeRes = new MatrixAction("notice", response);
                await this.ircBridge.sendMatrixAction(adminRoom, this.botUser, noticeRes);
            }
            // persist this desired nick
            let config = await this.ircBridge.getStore().getIrcClientConfig(
                sender, ircServer.domain
            );
            if (!config) {
                config = IrcClientConfig.newConfig(
                    new MatrixUser(sender), ircServer.domain, nick
                );
            }
            config.setDesiredNick(nick);
            await this.ircBridge.getStore().storeIrcClientConfig(config);
        }
        catch (err) {
            if (err.stack) {
                req.log.error(err);
            }
            const noticeErr = new MatrixAction("notice", err.message);
            await this.ircBridge.sendMatrixAction(adminRoom, this.botUser, noticeErr);
        }
    }

    private async handleFeature(args: string[], adminRoom: MatrixRoom, sender: string) {
        if (args.length === 0 || !USER_FEATURES.includes(args[0].toLowerCase())) {
            const notice = new MatrixAction("notice",
                "Missing or unknown feature flag. Must be one of: " + USER_FEATURES.join(", ")
            );
            await this.ircBridge.sendMatrixAction(adminRoom, this.botUser, notice);
            return;
        }
        const featureFlag = args[0];
        const features = await this.ircBridge.getStore().getUserFeatures(sender);
        if (!args[1]) {
            const val = features[featureFlag];
            let msg = `'${featureFlag}' is `;
            if (val === true) {
                msg += "enabled.";
            }
            else if (val === false) {
                msg += "disabled.";
            }
            else {
                msg += "set to the default value.";
            }
            const notice = new MatrixAction("notice", msg);
            await this.ircBridge.sendMatrixAction(adminRoom, this.botUser, notice);
            return;
        }
        if (!["true", "false", "default"].includes(args[1].toLowerCase())) {
            const notice = new MatrixAction("notice",
                "Parameter must be either true, false or default."
            );
            await this.ircBridge.sendMatrixAction(adminRoom, this.botUser, notice);
            return;
        }
        features[featureFlag] = args[1] === "default" ? undefined :
            args[1].toLowerCase() === "true";

        await this.ircBridge.getStore().storeUserFeatures(sender, features);
        let note = "";
        if (featureFlag === "mentions") {
            // We should invalidate caching for this user's channels.
            if (!this.ircBridge.ircHandler.invalidateCachingForUserId(sender)) {
                note = " This bridge has disabled mentions, so this flag will do nothing.";
            }
        }
        const notice = new MatrixAction("notice",
            `Set ${featureFlag} to ${features[featureFlag]}.${note}`
        );
        await this.ircBridge.sendMatrixAction(adminRoom, this.botUser, notice);
    }

    private async showBridgeVersion(adminRoom: MatrixRoom) {
        await this.ircBridge.sendMatrixAction(
            adminRoom,
            this.botUser,
            new MatrixAction("notice", `BridgeVersion: ${BridgeVersion}`)
        );
    }

    private async showHelp(adminRoom: MatrixRoom) {
        const notice = new MatrixAction("notice", null,
            "This is an IRC admin room for controlling your IRC connection and sending " +
            "commands directly to IRC. " +
            "The following commands are available:<br/><ul>\n\t" +
            Object.values(COMMANDS).map((c) =>
                `<li><strong>${c.example}</strong> : ${c.summary}</li>`
            ).join(`\n\t`) +
            `</ul>`,
        );
        await this.ircBridge.sendMatrixAction(adminRoom, this.botUser, notice);
    }
}
