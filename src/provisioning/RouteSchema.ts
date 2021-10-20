import { ConfigValidator } from "matrix-appservice-bridge";

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
