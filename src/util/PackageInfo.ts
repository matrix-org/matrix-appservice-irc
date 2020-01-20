
let BridgeVersion: string;

try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodePackage = require("../../package.json");
    BridgeVersion = nodePackage.version;
}
catch (err) { BridgeVersion = "unknown" }

export function getBridgeVersion() {
    return BridgeVersion;
}
