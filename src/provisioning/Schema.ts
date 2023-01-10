import { Response } from "express";
import { IApiError, ConfigValidator } from "matrix-appservice-bridge";

const matrixRoomIdSchema = {
    type: "string",
    pattern: "^!.*:.*$",
};

const remoteRoomChannelSchema = {
    type: "string",
    pattern: "^([#+&]|(![A-Z0-9]{5}))[^\\s:,]+$",
};

const remoteRoomServerSchema = {
    type: "string",
    pattern: "^[a-z\\.0-9:-]+$",
};

const opNickSchema = {
    type: "string",
};

const keySchema = {
    type: "string",
};

const roomIdSchema = {
    type: "object",
    properties: {
        "matrix_room_id" : matrixRoomIdSchema,
    },
    required: [
        "matrix_room_id",
    ],
};

// TODO: This is abusing ConfigValidator for request validation
export class RequestValidator<T> extends ConfigValidator {
    public errors: {field: string, message: string}[] = [];

    validate(payload: unknown): payload is T {
        try {
            super.validate(payload);
        }
        catch (e) {
            this.errors = e._validationErrors;
            return false;
        }
        return true;
    }
}

export interface QueryLinkBody {
    remote_room_channel: string;
    remote_room_server: string;
    key?: string;
}
const queryLinkBodySchema = {
    type: "object",
    properties: {
        remote_room_channel: remoteRoomChannelSchema,
        remote_room_server: remoteRoomServerSchema,
        key: keySchema,
    },
    required: [
        "remote_room_channel",
        "remote_room_server",
    ],
};
export const QueryLinkBodyValidator = new RequestValidator<QueryLinkBody>(queryLinkBodySchema);

export interface RequestLinkBody {
    remote_room_channel: string;
    remote_room_server: string;
    matrix_room_id: string;
    op_nick: string;
    key?: string;
}
const requestLinkBodySchema = {
    type: "object",
    properties: {
        remote_room_channel: remoteRoomChannelSchema,
        remote_room_server: remoteRoomServerSchema,
        matrix_room_id: roomIdSchema,
        op_nick: opNickSchema,
        key: keySchema,
    },
    required: [
        "remote_room_channel",
        "remote_room_server",
        "matrix_room_id",
        "op_nick",
    ],
};
export const RequestLinkBodyValidator = new RequestValidator<RequestLinkBody>(requestLinkBodySchema);

export interface UnlinkBody {
    remote_room_channel: string;
    remote_room_server: string;
    matrix_room_id: string;
}
const unlinkBodySchema = {
    type: "object",
    properties: {
        remote_room_channel: remoteRoomChannelSchema,
        remote_room_server: remoteRoomServerSchema,
        matrix_room_id: matrixRoomIdSchema,
    },
    required: [
        "remote_room_channel",
        "remote_room_server",
        "matrix_room_id",
    ],
};
export const UnlinkBodyValidator = new RequestValidator<UnlinkBody>(unlinkBodySchema);

export interface ListingsParams {
    matrix_room_id: string;
}
const listingsParamsSchema = {
    type: "object",
    properties: {
        roomId: matrixRoomIdSchema,
    },
    required: [
        "roomId",
    ],
};
export const ListingsParamsValidator = new RequestValidator<ListingsParams>(listingsParamsSchema);

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
