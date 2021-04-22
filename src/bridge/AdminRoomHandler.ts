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
import { MatrixHandler, MatrixSimpleMessage } from "./MatrixHandler";
import logging from "../logging";
import * as RoomCreation from "./RoomCreation";
import { getBridgeVersion } from "../util/PackageInfo";
import { ProvisionRequest } from "../provisioning/ProvisionRequest";

const log = logging("AdminRoomHandler");

const COMMANDS: {[command: string]: {example: string; summary: string; requiresPermission?: string}} = {
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
    "!listrooms": {
        example: `!listrooms [irc.example.net]`,
        summary: "List all of your joined channels, and the rooms they are bridged into.",
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
    },
    '!plumb': {
        example: `!plumb !room:example.com irc.example.net #foobar`,
        summary: "Plumb an IRC channel into a Matrix room.",
        requiresPermission: 'admin'
    },
    '!unlink': {
        example: `!unlink !room:example.com irc.example.net #foobar`,
        summary: "Unlink an IRC channel from a Matrix room.",
        requiresPermission: 'admin'
    }
};

const USER_FEATURES = ["mentions"];
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
        const userDomain = event.sender.split(':')[1];
        const userPermission = this.ircBridge.config.ircService.permissions &&
                               (this.ircBridge.config.ircService.permissions[event.sender] || // This takes priority
                               this.ircBridge.config.ircService.permissions[userDomain] || // Then the domain
                               this.ircBridge.config.ircService.permissions['*']); // Finally wildcard.

        let response: MatrixAction|void;
        switch (cmd) {
            case "!join":
                response = await this.handleJoin(req, args, ircServer, event.sender);
                break;
            case "!cmd":
                response = await this.handleCmd(req, args, ircServer, event.sender);
                break;
            case "!whois":
                response = await this.handleWhois(req, args, ircServer, event.sender);
                break;
            case "!storepass":
                response = await this.handleStorePass(req, args, ircServer, event.sender, clientList);
                break;
            case "!removepass":
                response = await this.handleRemovePass(ircServer, event.sender);
                break;
            case "!listrooms":
                response = await this.handleListRooms(ircServer, event.sender);
                break;
            case "!quit":
                response = await this.handleQuit(req, event.sender, ircServer, clientList);
                break;
            case "!nick":
                response = await this.handleNick(req, args, ircServer, clientList, event.sender);
                break;
            case "!feature":
                response = await this.handleFeature(args, event.sender);
                break;
            case "!bridgeversion":
                response = await this.showBridgeVersion();
                break;
            case "!plumb":
                response = await this.handlePlumb(args, event.sender, userPermission)
                break;
            case "!unlink":
                response = await this.handleUnlink(args, event.sender, userPermission)
                break;
            case "!help":
                response = await this.showHelp(userPermission);
                break;
            default: {
                response = new MatrixAction("notice",
                    "The command was not recognised. Available commands are listed by !help");
            }
        }
        if (response) {
            response.replyEvent = event.event_id;
            await this.ircBridge.sendMatrixAction(adminRoom, this.botUser, response);
        }
    }

    private async handlePlumb(args: string[], sender: string, userPermission: string|undefined) {
        if (userPermission !== 'admin') {
            return new MatrixAction("notice", "You must be an admin to use this command");
        }
        const [matrixRoomId, serverDomain, ircChannel] = args;
        const server = serverDomain && this.ircBridge.getServer(serverDomain);
        if (!server) {
            return new MatrixAction("notice", "The server provided is not configured on this bridge");
        }
        if (!ircChannel || !ircChannel.startsWith("#")) {
            return new MatrixAction("notice", "The channel name must start with a #");
        }
        // Check if the room exists and the user is invited.
        const intent = this.ircBridge.getAppServiceBridge().getIntent();
        try {
            await intent.getStateEvent(matrixRoomId, 'm.room.create');
        }
        catch (ex) {
            log.error(`Could not join the target room of a !plumb command`, ex);
            return new MatrixAction("notice", "Could not join the target room, you may need to invite the bot");
        }
        try {
            await this.ircBridge.getProvisioner().doLink(
                ProvisionRequest.createFake("adminCommand", log),
                server,
                ircChannel,
                undefined,
                matrixRoomId,
                sender,
            );
        }
        catch (ex) {
            log.error(`Failed to handle !plumb command:`, ex);
            return new MatrixAction("notice", "Failed to plumb room. Check the logs for details.");
        }
        return new MatrixAction("notice", "Room plumbed.");
    }

    private async handleUnlink(args: string[], sender: string, userPermission: string | undefined) {
        if (userPermission !== 'admin') {
            return new MatrixAction("notice", "You must be an admin to use this command");
        }
        const [matrixRoomId, serverDomain, ircChannel] = args;
        const server = serverDomain && this.ircBridge.getServer(serverDomain);
        if (!server) {
            return new MatrixAction("notice", "The server provided is not configured on this bridge");
        }
        if (!ircChannel || !ircChannel.startsWith("#")) {
            return new MatrixAction("notice", "The channel name must start with a #");
        }
        // Check if the room exists and the user is invited.
        const intent = this.ircBridge.getAppServiceBridge().getIntent();
        try {
            await intent.getStateEvent(matrixRoomId, 'm.room.create');
        }
        catch (ex) {
            log.error(`Could not join the target room of a !plumb command`, ex);
            return new MatrixAction("notice", "Could not join the target room, you may need to invite the bot");
        }
        try {
            await this.ircBridge.getProvisioner().unlink(
                ProvisionRequest.createFake("adminCommand", log),
                {
                    remote_room_server: serverDomain,
                    remote_room_channel: ircChannel,
                    matrix_room_id: matrixRoomId,
                    user_id: sender,
                },
            );
        }
        catch (ex) {
            log.error(`Failed to handle !plumb command:`, ex);
            return new MatrixAction("notice", "Failed to plumb room. Check the logs for details.");
        }
        return new MatrixAction("notice", "Room plumbed.");
    }

    private async handleJoin(req: BridgeRequest, args: string[], server: IrcServer, sender: string) {
        // check that the server exists and that the user_id is on the whitelist
        const ircChannel = args[0];
        const key = args[1]; // keys can't have spaces in them, so we can just do this.
        let errText = null;
        if (!ircChannel || !ircChannel.startsWith("#")) {
            errText = "Format: '!join irc.example.com #channel [key]'";
        }
        else if (!server.canJoinRooms(sender)) {
            errText = "You are not authorised to join channels on this server.";
        }

        if (errText) {
            return new MatrixAction("notice", errText);
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
            const { ircRoom, mxRoom } = await RoomCreation.trackChannelAndCreateRoom(this.ircBridge, req, {
                origin: "join",
                server: server,
                ircChannel,
                key,
                inviteList: [sender],
            });
            req.log.info(
                "Created a room to track %s on %s and invited %s",
                ircRoom.channel, server.domain, sender
            );
            matrixRooms.push(mxRoom);
        }
        else {
            // already tracking channel, so just invite them.
            await Promise.all(matrixRooms.map(async (r) => {
                req.log.info(
                    "Inviting %s to room %s", sender, r.getId()
                );
                try {
                    await this.ircBridge.getAppServiceBridge().getIntent().invite(
                        r.getId(), sender
                    );
                }
                catch (ex) {
                    log.warn(`Failed to invite ${sender} to ${r.getId()}:`, ex);
                }
            }));
        }
        // check whether we should be force joining the IRC user
        for (let i = 0; i < matrixRooms.length; i++) {
            const m = matrixRooms[i];
            const userMustJoin = (
                key ?? server.shouldSyncMembershipToIrc("incremental", m.getId())
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
        return undefined;
    }

    private async handleCmd(req: BridgeRequest, args: string[], server: IrcServer, sender: string) {
        req.log.info(`No valid (old form) admin command, will try new format`);

        // Assumes commands have the form
        // !cmd [irc.server] COMMAND [arg0 [arg1 [...]]]

        const blacklist = ['PROTOCTL'];

        try {
            const keyword = args[0];

            // keyword could be a failed server or a malformed command
            if (!keyword.match(/^[A-Z]+$/)) {
                // if not a domain OR is only word (which implies command)
                if (!keyword.match(/^[a-z0-9:\.-]+$/) || args.length === 1) {
                    throw new Error(`Malformed command: ${keyword}`);
                }
                else {
                    throw new Error(`Domain not accepted: ${keyword}`);
                }
            }

            if (blacklist.includes(keyword)) {
                throw new Error(`Command blacklisted: ${keyword}`);
            }

            // If no args after COMMAND, this will be []
            const sendArgs = args.splice(1);
            sendArgs.unshift(keyword);

            const bridgedClient = await this.ircBridge.getBridgedClient(
                server, sender
            );

            bridgedClient.sendCommands(...sendArgs);
        }
        catch (err) {
            return new MatrixAction("notice", `${err}\n` );
        }
        return undefined;
    }

    private async handleWhois(req: BridgeRequest, args: string[], server: IrcServer, sender: string) {
        // Format is: "!whois <nick>"

        const whoisNick = args.length === 1 ? args[0] : null; // ensure 1 arg
        if (!whoisNick) {
            return new MatrixAction("notice", "Format: '!whois nick|mxid'");
        }

        if (whoisNick[0] === "@") {
            // querying a Matrix user - whoisNick is the matrix user ID
            req.log.info("%s wants whois info on %s", sender, whoisNick);
            const whoisClient = this.ircBridge.getIrcUserFromCache(server, whoisNick);
            try {
                return new MatrixAction(
                    "notice",
                    whoisClient ?
                        `${whoisNick} is connected to ${server.domain} as '${whoisClient.nick}'.` :
                        `${whoisNick} has no IRC connection via this bridge.`);
            }
            catch (err) {
                if (err.stack) {
                    req.log.error(err);
                }
                return new MatrixAction("notice", "Failed to perform whois query.");
            }
        }

        req.log.info("%s wants whois info on %s on %s", sender,
            whoisNick, server.domain);
        const bridgedClient = await this.ircBridge.getBridgedClient(server, sender);
        try {
            const response = await bridgedClient.whois(whoisNick);
            return new MatrixAction("notice", response?.msg || "User not found");
        }
        catch (err) {
            if (err.stack) {
                req.log.error(err);
            }
            return new MatrixAction("notice", err.message);
        }
    }

    private async handleStorePass(req: BridgeRequest, args: string[], server: IrcServer,
                                  userId: string, clientList: BridgedClient[]) {
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
                const client = clientList.find((c) => c.server.domain === server.domain);
                if (client) {
                    await client.disconnect("iwanttoreconnect", "authenticating", false);
                }
            }
        }
        catch (err) {
            req.log.error(err.stack);
            return new MatrixAction(
                "notice", `Failed to store password: ${err.message}`
            );
        }
        return notice;
    }

    private async handleRemovePass(ircServer: IrcServer, userId: string) {
        const domain = ircServer.domain;

        try {
            await this.ircBridge.getStore().removePass(userId, domain);
            return new MatrixAction(
                "notice", `Successfully removed password.`
            );
        }
        catch (err) {
            return new MatrixAction(
                "notice", `Failed to remove password: ${err.message}`
            );
        }
    }

    private async handleListRooms(server: IrcServer, sender: string) {
        const client = this.ircBridge.getIrcUserFromCache(server, sender);
        if (!client || client.isDead()) {
            return new MatrixAction(
                "notice", "You are not currently connected to this irc network"
            );
        }
        if (client.chanList.size === 0) {
            return new MatrixAction(
                "notice", "You are connected, but not joined to any channels."
            );
        }

        let chanList = `You are joined to ${client.chanList.size} rooms: \n\n`;
        let chanListHTML = `<p>You are joined to <code>${client.chanList.size}</code> rooms:</p><ul>`;
        for (const channel of client.chanList) {
            const rooms = await this.ircBridge.getStore().getMatrixRoomsForChannel(server, channel);
            chanList += `- \`${channel}\` which is bridged to ${rooms.map((r) => r.getId()).join(", ")}`;
            const roomMentions = rooms
                .map((r) => `<a href="https://matrix.to/#/${r.getId()}">${r.getId()}</a>`)
                .join(", ");
            chanListHTML += `<li><code>${channel}</code> which is bridged to ${roomMentions} </li>`
        }
        chanListHTML += "</ul>"

        return new MatrixAction(
            "notice", chanList, chanListHTML
        );
    }

    private async handleQuit(req: BridgeRequest, sender: string, server: IrcServer, clients: BridgedClient[]) {
        const msgText = await this.matrixHandler.quitUser(
            req, sender, clients, server, "issued !quit command"
        );
        return msgText ? new MatrixAction("notice", msgText) : undefined;
    }

    private async handleNick(req: BridgeRequest, args: string[], ircServer: IrcServer, clientList: BridgedClient[],
                             sender: string) {
        // Format is: "!nick irc.example.com NewNick"
        if (!ircServer.allowsNickChanges()) {
            return new MatrixAction("notice",
                "Server " + ircServer.domain + " does not allow nick changes."
            );
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
            return new MatrixAction("notice",
                "Format: '!nick DesiredNick' or '!nick irc.server.name DesiredNick'\n" +
                connectedNetworksStr
            );
        }
        req.log.info("%s wants to change their nick on %s to %s",
            sender, ircServer.domain, nick);

        if (ircServer.claimsUserId(sender)) {
            req.log.error("%s is a virtual user!", sender);
            return undefined;
        }

        // change the nick
        const bridgedClient = await this.ircBridge.getBridgedClient(ircServer, sender);
        let notice;
        try {
            if (bridgedClient) {
                const response = await bridgedClient.changeNick(nick, true);
                notice = new MatrixAction("notice", response);
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
            return new MatrixAction("notice", err.message);
        }
        return notice;
    }

    private async handleFeature(args: string[], sender: string) {
        if (args.length === 0 || !USER_FEATURES.includes(args[0].toLowerCase())) {
            return new MatrixAction("notice",
                "Missing or unknown feature flag. Must be one of: " + USER_FEATURES.join(", ")
            );
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
            return new MatrixAction("notice", msg);
        }
        if (!["true", "false", "default"].includes(args[1].toLowerCase())) {
            return new MatrixAction("notice",
                "Parameter must be either true, false or default."
            );
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
        return new MatrixAction("notice",
            `Set ${featureFlag} to ${features[featureFlag]}.${note}`
        );
    }

    private async showBridgeVersion() {
        return new MatrixAction("notice", `BridgeVersion: ${getBridgeVersion()}`);
    }

    private async showHelp(userPermission: string|undefined) {
        return new MatrixAction("notice", null,
            "This is an IRC admin room for controlling your IRC connection and sending " +
            "commands directly to IRC. " +
            "The following commands are available:<br/><ul>\n\t" +
            Object.values(COMMANDS).filter(
                (c) => !c.requiresPermission || c.requiresPermission === userPermission).map((c) =>
                `<li><strong>${c.example}</strong> : ${c.summary}</li>`
            ).join(`\n\t`) +
            `</ul>`,
        );
    }
}
