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
            case "!help":
            default:
                await this.showHelp(adminRoom);
                break;
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