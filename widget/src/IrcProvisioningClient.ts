import { ProvisioningClient } from "./ProvisioningClient";

export interface QueryNetworksResponse {
    servers: {
        bot_user_id: string,
        desc: string,
        fields: {
            domain: string,
        },
        network_id: string,
    }[]
}

export type ListLinksResponse = {
    matrix_room_id: string,
    remote_room_channel: string,
    remote_room_server: string,
}[];

export class IrcProvisioningClient {
    constructor(
        readonly client: ProvisioningClient,
    ) {}

    async queryNetworks(): Promise<QueryNetworksResponse> {
        return await this.client.request(
            'GET',
            '/querynetworks',
        ) as QueryNetworksResponse;
    }

    async listLinks(roomId: string): Promise<ListLinksResponse> {
        return await this.client.request(
            'GET',
            `/listlinks/${roomId}`,
        ) as ListLinksResponse;
    }

    async requestLink(
        server: string,
        channel: string,
        roomId: string,
        opNick: string,
        key?: string,
    ): Promise<void> {
        await this.client.request(
            'POST',
            '/link',
            {
                matrix_room_id: roomId,
                remote_room_channel: channel,
                remote_room_server: server,
                op_nick: opNick,
                key: key,
            },
        );
    }

    async unlink(roomId: string, channel: string, server: string): Promise<void> {
        await this.client.request(
            'POST',
            '/unlink',
            {
                matrix_room_id: roomId,
                remote_room_channel: channel,
                remote_room_server: server,
            }
        );
    }
}
