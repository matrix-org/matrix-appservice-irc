import { IApiError, ConfigValidator } from "matrix-appservice-bridge";
import { Response } from "express";

const matrixRoomIdValidation = {
    type: "string",
    pattern: "^!.*:.*$"
};

const validationProperties = {
    matrix_room_id : matrixRoomIdValidation,
    remote_room_channel : {
        type: "string",
        pattern: "^([#+&]|(![A-Z0-9]{5}))[^\\s:,]+$"
    },
    remote_room_server : {
        type: "string",
        pattern: "^[a-z\\.0-9:-]+$"
    },
    op_nick : {
        type: "string"
    },
    key : {
        type: "string"
    },
    user_id : {
        type: "string"
    }
};

interface RouteValidatorSchema {
    type: "object",
    properties: Record<string, {type: string}>,
    required: string[],
}

export interface LinkValidatorProperties {
    matrix_room_id: string;
    remote_room_channel: string;
    remote_room_server: string;
    op_nick: string;
    user_id: string;
    key?: string;
}

export const LinkValidator = new ConfigValidator({
    type: "object",
    properties: validationProperties,
    required: [
        "matrix_room_id",
        "remote_room_channel",
        "remote_room_server",
        "op_nick",
        "user_id"
    ]
} as RouteValidatorSchema);


export interface QueryLinkValidatorProperties {
    remote_room_channel: string;
    remote_room_server: string;
    key?: string;
}

export const QueryLinkValidator = new ConfigValidator({
    type: "object",
    properties: validationProperties,
    required: [
        "remote_room_channel",
        "remote_room_server",
        "key"
    ]
} as RouteValidatorSchema);

export interface UnlinkValidatorProperties {
    remote_room_channel: string;
    remote_room_server: string;
    user_id: string;
    matrix_room_id: string;
}

export const UnlinkValidator = new ConfigValidator({
    type: "object",
    properties: validationProperties,
    required: [
        "matrix_room_id",
        "remote_room_channel",
        "remote_room_server",
        "user_id"
    ]
} as RouteValidatorSchema);

export interface ListingsProperties {
    matrix_room_id: string;
}

export const RoomIdValidator = new ConfigValidator({
    type: "object",
    properties: {
        "matrix_room_id" : matrixRoomIdValidation,
    },
    required: [
        "matrix_room_id",
    ],
} as RouteValidatorSchema);

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

    get jsonBody(): {errcode: string, error: string} {
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
