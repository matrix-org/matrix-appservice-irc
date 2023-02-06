import { ProvisioningClient } from './ProvisioningClient';

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

export interface QueryLinkResponse {
    operators: string[],
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

    /**
     * List IRC servers configured on the bridge.
     *
     * @returns Promise resolving to the list of servers.
     */
    async queryNetworks(): Promise<QueryNetworksResponse> {
        return await this.client.request(
            'GET',
            '/querynetworks',
        ) as QueryNetworksResponse;
    }

    /**
     * List the operators in an IRC channel.
     * This will cause the bot to join the channel.
     *
     * @param server IRC server
     * @param channel IRC channel
     * @param key Channel key (if any)
     * @returns Promise resolving to the list of operators.
     */
    async queryLink(
        server: string,
        channel: string,
        key?: string,
    ): Promise<QueryLinkResponse> {
        return await this.client.request(
            'POST',
            '/querylink',
            {
                'remote_room_server': server,
                'remote_room_channel': channel,
                key,
            },
        ) as QueryLinkResponse;
    }

    /**
     * List the IRC channels currently bridged to a Matrix room.
     *
     * @param roomId Matrix room ID
     * @returns Promise resolving to the list of IRC channels.
     */
    async listLinks(roomId: string): Promise<ListLinksResponse> {
        return await this.client.request(
            'GET',
            `/listlinks/${roomId}`,
        ) as ListLinksResponse;
    }

    /**
     * Create a request to link an IRC Channel to a Matrix room.
     * This will cause the bot to message the specified operator to ask for approval.
     *
     * @param server IRC server
     * @param channel IRC channel
     * @param roomId Matrix room ID
     * @param opNick Operator nick the bot should ask for approval.
     * @param key Channel key (if any)
     * @returns Promise resolving when the request has been made.
     */
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

    /**
     * Remove a linked IRC channel and Matrix room.
     *
     * @param roomId Matrix room ID
     * @param channel IRC channel
     * @param server IRC server
     * @returns Promise resolving when the channel has been unlinked.
     */
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
