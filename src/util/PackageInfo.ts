let BridgeVersion: string;

const nodePackage = require("../../package.json");

try {
    BridgeVersion = nodePackage.version;
}
catch (err) { BridgeVersion = "unknown" }

export function getBridgeVersion() {
    return BridgeVersion;
}
