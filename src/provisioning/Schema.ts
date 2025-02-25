import { Response } from "express";
import Ajv, { JSONSchemaType } from "ajv";
import { IApiError } from "matrix-appservice-bridge";

export const ajv = new Ajv({
    allErrors: true,
});

const matrixRoomIdSchema: JSONSchemaType<string> = {
    type: "string",
    pattern: "^![^!]+$",
};

const remoteRoomChannelSchema: JSONSchemaType<string> = {
    type: "string",
    // According to https://www.rfc-editor.org/rfc/rfc1459#section-1.3
    // eslint-disable-next-line no-control-regex
    pattern: "^#([^:\\x00-\\x1F\\s,]){1,199}$",
};

const remoteRoomServerSchema: JSONSchemaType<string> = {
    type: "string",
    pattern: "^[a-z\\.0-9:-]+$",
};

const opNickSchema: JSONSchemaType<string> = {
    type: "string",
};

const keySchema: JSONSchemaType<string> = {
    type: "string",
    // The regex was designed with the following considerations:
    // - It cannot start with ':' because that would indicate a trailing
    //   parameter and we treat key exclusively as a middle parameter.
    // - Commas are disallowed to prevent multiple keys, as we do not support
    //   joining multiple channels simultaneously.
    // - Space is disallowed because it signifies the end of the parameter. We
    //   use \s instead of a literal space to also exclude some Unicode
    //   whitespace characters out of precaution.
    //   (see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_expressions/Cheatsheet)
    // - Control characters (ASCII 00-1F) are excluded to prevent issues with
    //   printing and parsing reliability. This is more stringent than
    //   recommended by RFC2812.
    pattern: "^(?!:)[^\\x00-\\x1F\\s,]*$",
    nullable: true,
};

export interface QueryLinkBody {
    remote_room_channel: string;
    remote_room_server: string;
    key: string|null;
}
const queryLinkBodySchema: JSONSchemaType<QueryLinkBody> = {
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
export const isValidQueryLinkBody = ajv.compile(queryLinkBodySchema);

export interface RequestLinkBody {
    remote_room_channel: string;
    remote_room_server: string;
    matrix_room_id: string;
    op_nick: string;
    key: string|null;
}
const requestLinkBodySchema: JSONSchemaType<RequestLinkBody> = {
    type: "object",
    properties: {
        remote_room_channel: remoteRoomChannelSchema,
        remote_room_server: remoteRoomServerSchema,
        matrix_room_id: matrixRoomIdSchema,
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
export const isValidRequestLinkBody = ajv.compile(requestLinkBodySchema);

export interface UnlinkBody {
    remote_room_channel: string;
    remote_room_server: string;
    matrix_room_id: string;
}
const unlinkBodySchema: JSONSchemaType<UnlinkBody> = {
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
export const isValidUnlinkBody = ajv.compile(unlinkBodySchema);

export interface ListingsParams {
    roomId: string;
}
const listingsParamsSchema: JSONSchemaType<ListingsParams> = {
    type: "object",
    properties: {
        roomId: matrixRoomIdSchema,
    },
    required: [
        "roomId",
    ],
};
export const isValidListingsParams = ajv.compile(listingsParamsSchema);

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
