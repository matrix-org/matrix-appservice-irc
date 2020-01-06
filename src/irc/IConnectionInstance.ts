import { Client } from "irc";

export type InstanceDisconnectReason = "throttled"|"irc_error"|"net_error"|"timeout"|"raw_error"|
                                       "toomanyconns"|"banned"|"killed"|"idle"|"limit_reached"|
                                       "iwantoreconnect";

export interface ConnectionInstance {
    dead: boolean;
    localPort: null|number;
    onDisconnect?: (reason: string) => void;
    connect: () => Promise<ConnectionInstance>;
    disconnect: (reason: InstanceDisconnectReason, ircReason?: string) => Promise<void>;
}
