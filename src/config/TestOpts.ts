import { Intent } from "matrix-appservice-bridge";

/**
 * Options to set when testing the bridge.
 */
export interface TestingOptions {
    // Is the NEDB database stored in memory.
    isDBInMemory: boolean;
    // Should we skip sending a ping to the remote side.
    skipPingCheck?: boolean;
    onIntentCreate?: (userId?: string) => Intent,
}
