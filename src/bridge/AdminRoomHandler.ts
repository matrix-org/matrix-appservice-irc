import { BridgeRequest } from "../models/BridgeRequest";
import { MatrixRoom, MatrixUser } from "matrix-appservice-bridge";
import { IrcBridge } from "./IrcBridge";
import { MatrixAction } from "../models/MatrixAction";
import { IrcServer } from "../irc/IrcServer";
import { BridgedClient } from "../irc/BridgedClient";
import { IrcClientConfig } from "../models/IrcClientConfig";

const COMMANDS = {
    "!join": {
        example: `!join [irc.example.net] #channel [key]`,
        summary: `Join a channel (with optional channel key)`,
    },
    "!nick": {
        example: `!nick [irc.example.net] DesiredNick`,
        summary: "Change your nick. If no arguments are supplied, " +
                "your current nick is shown.",
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
    "!feature": {
        example: `!feature feature-name [true/false/default]`,
        summary: `Enable, disable or default a feature's status for your account.` +
                `Will display the current feature status if true/false/default not given.`,
    },
    "!quit": {
        example: `!quit`,
        summary: "Leave all bridged channels, on all networks, and remove your " +
                "connections to all networks.",
    },
    "!cmd": {
        example: `!cmd [irc.example.net] COMMAND [arg0 [arg1 [...]]]`,
        summary: "Issue a raw IRC command. These will not produce a reply." +
                "(Note that the command must be all uppercase.)",
    },
    "!bridgeversion": {
        example: `!bridgeversion`,
        summary: "Return the version from matrix-appservice-irc bridge.",
    }
};

interface MatrixSimpleMessage {
    sender: string;
    content: {
        body: string;
    };
}

export class AdminRoomHandler {
    private readonly botUser: MatrixUser;
    constructor(private ircBridge: IrcBridge, botUserId: string) {
        this.botUser = new MatrixUser(botUserId, undefined, false);

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
        
        switch(cmd) {
            case "!join":
                await this.handleJoin(req, args, ircServer, adminRoom, event.sender);
                break;
            case "!cmd":
                await this.handleCmd(req, args, ircServer, adminRoom, event.sender);
                break;
            case "!whois":
                await this.handleWhois(req, args, ircServer, adminRoom, event.sender);
                break;
            case "!help":
            default:
                await this.showHelp(adminRoom);
                break;
    private async handleJoin(req: BridgeRequest, args: string[], ircServer: IrcServer, adminRoom: MatrixRoom, sender: string) {
        // TODO: Code dupe from !nick
        // Format is: "!join irc.example.com #channel [key]"

        // check that the server exists and that the user_id is on the whitelist
        const ircChannel = args[0];
        const key = args[1]; // keys can't have spaces in them, so we can just do this.
        let errText = null;
        if (!ircChannel || ircChannel.indexOf("#") !== 0) {
            errText = "Format: '!join irc.example.com #channel [key]'";
        }
        else if (ircServer.hasInviteRooms() && !ircServer.isInWhitelist(sender)) {
            errText = "You are not authorised to join channels on this server.";
        }

        if (errText) {
            await this.ircBridge.sendMatrixAction(
                adminRoom, this.botUser, new MatrixAction("notice", errText)
            );
            return;
        }
        req.log.info("%s wants to join the channel %s on %s", sender, ircChannel, ircServer.domain);

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
            ircServer, ircChannel
        );

        if (matrixRooms.length === 0) {
            // track the channel then invite them.
            // TODO: Dupes onAliasQuery a lot
            const initialState: unknown[] = [
                {
                    type: "m.room.join_rules",
                    state_key: "",
                    content: {
                        join_rule: ircServer.getJoinRule()
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
            if (ircServer.areGroupsEnabled()) {
                initialState.push({
                    type: "m.room.related_groups",
                    state_key: "",
                    content: {
                        groups: [ircServer.getGroupId() as string]
                    }
                });
            }
            const ircRoom = await this.ircBridge.trackChannel(ircServer, ircChannel, key);
            const response = await this.ircBridge.getAppServiceBridge().getIntent(
                sender,
            ).createRoom({
                options: {
                    name: ircChannel,
                    visibility: "private",
                    preset: "public_chat",
                    creation_content: {
                        "m.federate": ircServer.shouldFederate()
                    },
                    initial_state: initialState,
                }
            });
            const mxRoom = new MatrixRoom(response.room_id);
            await this.ircBridge.getStore().storeRoom(ircRoom, mxRoom, 'join');
            // /mode the channel AFTER we have created the mapping so we process
            // +s and +i correctly.
            const domain = ircServer.domain;
            this.ircBridge.publicitySyncer.initModeForChannel(ircServer, ircChannel).catch(() => {
                log.error(
                    `Could not init mode for channel ${ircChannel} on ${domain}`
                );
            });
            req.log.info(
                "Created a room to track %s on %s and invited %s",
                ircRoom.channel, ircServer.domain, sender
            );
            matrixRooms.push(mxRoom);
        }

        // already tracking channel, so just invite them.
        const invitePromises = matrixRooms.map((room) => {
            req.log.info(
                "Inviting %s to room %s", sender, room.getId()
            );
            return this.ircBridge.getAppServiceBridge().getIntent().invite(
                room.getId(), sender
            );
        });
        for (const room of matrixRooms) {
            const userMustJoin = (
                key || ircServer.shouldSyncMembershipToIrc("incremental", room.getId())
            );
            if (!userMustJoin) {
                continue;
            }
            const bc = await this.ircBridge.getBridgedClient(
                ircServer, sender
            );
            await bc.joinChannel(ircChannel, key);
            break;
        }
        // check whether we should be force joining the IRC user
        for (let i = 0; i < matrixRooms.length; i++) {
            const m = matrixRooms[i];
            const userMustJoin = (
                key || ircServer.shouldSyncMembershipToIrc("incremental", m.getId())
            );
            if (userMustJoin) {
                // force join then break out (we only ever join once no matter how many
                // rooms the channel is bridged to)
                const bc = await this.ircBridge.getBridgedClient(
                    ircServer, sender
                );
                await bc.joinChannel(ircChannel, key);
                break;
            }
        }

        await Promise.all(invitePromises);
    }

    private async handleCmd(req: BridgeRequest, args: string[], ircServer: IrcServer, adminRoom: MatrixRoom, sender: string) {
        req.log.info(`No valid (old form) admin command, will try new format`);

        // Assumes commands have the form
        // !cmd [irc.server] COMMAND [arg0 [arg1 [...]]]

        const currentServer = ircServer;
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
                currentServer, sender
            );

            if (!bridgedClient.unsafeClient) {
                throw new Error('Possibly disconnected');
            }

            bridgedClient.unsafeClient.send(...sendArgs);
        }
        catch (err) {
            const notice = new MatrixAction("notice", `${err}\n` );
            await this.ircBridge.sendMatrixAction(adminRoom, this.botUser, notice);
            return;
        }
    }

    private async handleWhois(req: BridgeRequest, args: string[], ircServer: IrcServer, adminRoom: MatrixRoom, sender: string) {
        // Format is: "!whois <nick>"

        const whoisNick = args.length === 1 ? args[0] : null; // ensure 1 arg
        if (!whoisNick) {
            await this.ircBridge.sendMatrixAction(
                adminRoom, this.botUser,
                new MatrixAction("notice", "Format: '!whois nick|mxid'")
            );
            return;
        }

        if (whoisNick[0] === "@") {
            // querying a Matrix user - whoisNick is the matrix user ID
            req.log.info("%s wants whois info on %s", sender, whoisNick);
            const whoisClient = this.ircBridge.getIrcUserFromCache(ircServer, whoisNick);
            try {
                const noticeRes = new MatrixAction(
                    "notice",
                    whoisClient ?
                    `${whoisNick} is connected to ${ircServer.domain} as '${whoisClient.nick}'.` :
                    `${whoisNick} has no IRC connection via this bridge.`);
                await this.ircBridge.sendMatrixAction(adminRoom, this.botUser, noticeRes);
            }
            catch (err) {
                if (err.stack) {
                    req.log.error(err);
                }
                const noticeErr = new MatrixAction("notice", "Failed to perform whois query.");
                await this.ircBridge.sendMatrixAction(adminRoom, this.botUser, noticeErr);
            }
            return;
        }

        req.log.info("%s wants whois info on %s on %s", sender,
            whoisNick, ircServer.domain);
        const bridgedClient = await this.ircBridge.getBridgedClient(ircServer, sender);
        try {
            const response = await bridgedClient.whois(whoisNick);
            const noticeRes = new MatrixAction("notice", response.msg);
            await this.ircBridge.sendMatrixAction(adminRoom, this.botUser, noticeRes);
        }
        catch (err) {
            if (err.stack) {
                req.log.error(err);
            }
            const noticeErr = new MatrixAction("notice", err.message);
            await this.ircBridge.sendMatrixAction(adminRoom, this.botUser, noticeErr);
        }
    }
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
        return;
    }
}