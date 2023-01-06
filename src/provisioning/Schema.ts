import { Response } from "express";
import { IApiError } from "matrix-appservice-bridge";

export enum IrcErrCode {
    UnknownNetwork = "IRC_UNKNOWN_NETWORK",
    UnknownChannel = "IRC_UNKNOWN_CHANNEL",
    UnknownRoom = "IRC_UNKNOWN_ROOM",
    DoubleBridge = "IRC_DOUBLE_BRIDGE",
    ExistingMapping = "IRC_EXISTING_MAPPING",
    ExistingRequest = "IRC_EXISTING_REQUEST",
    NotEnoughPower = "IRC_NOT_ENOUGH_POWER",
    BadOpTarget = "IRC_BAD_OPERATOR_TARGET",
    BridgeAtLimit = "IRC_BRIDGE_AT_LIMIT",
}

const ErrCodeToStatusCode: Record<IrcErrCode, number> = {
    IRC_UNKNOWN_NETWORK: 404,
    IRC_UNKNOWN_CHANNEL: 404,
    IRC_UNKNOWN_ROOM: 404,
    IRC_EXISTING_MAPPING: 409,
    IRC_EXISTING_REQUEST: 409,
    IRC_DOUBLE_BRIDGE: 409,
    IRC_NOT_ENOUGH_POWER: 403,
    IRC_BAD_OPERATOR_TARGET: 400,
    IRC_BRIDGE_AT_LIMIT: 500
}

export class IrcProvisioningError extends Error implements IApiError {
    constructor(
        public readonly error: string,
        public readonly errcode: IrcErrCode,
        public readonly statusCode = -1,
        public readonly additionalContent: Record<string, unknown> = {},
    ) {
        super(`API error ${errcode}: ${error}`);
        if (statusCode === -1) {
            this.statusCode = ErrCodeToStatusCode[errcode];
        }
    }

    get jsonBody(): { errcode: string, error: string } {
        return {
            errcode: this.errcode,
            error: this.error,
            ...this.additionalContent,
        }
    }

    public apply(response: Response): void {
        response.status(this.statusCode).send(this.jsonBody);
    }
}
