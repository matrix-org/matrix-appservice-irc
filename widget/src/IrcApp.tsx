import React, {useCallback, useEffect, useState} from 'preact/compat';

import { useProvisioningContext } from './ProvisioningApp';
import { ProvisioningError } from './ProvisioningClient';
import { IrcProvisioningClient, ListLinksResponse, QueryNetworksResponse } from './IrcProvisioningClient';
import * as Text from './components/text';
import * as Buttons from './components/buttons';
import * as Forms from './components/forms';
import * as Alerts from './components/alerts';

const LinkedChannelItem = ({
    channel,
    server,
    unlinkChannel,
    disabled,
}: {
    server: string,
    channel: string,
    unlinkChannel: (channel: string, server: string) => Promise<void>,
    disabled: boolean,
}) => {
    const unlink = useCallback(async() => {
        await unlinkChannel(channel, server);
    }, [unlinkChannel, channel, server]);

    return <div
        className="flex justify-between items-center border border-grey-50 rounded-lg p-2"
        key={`${server}/${channel}`}
    >
        <p>{ `${server}/${channel}` }</p>
        <Buttons.Danger
            className="bg-grey-50 text-black-900"
            onClick={unlink}
            disabled={disabled}
        >
            Unlink
        </Buttons.Danger>
    </div>
};

const LinkedChannels = ({
    client,
    roomId,
}: {
    client: IrcProvisioningClient
    roomId: string,
}) => {
    const [error, setError] = useState('');
    const [links, setLinks] = useState<ListLinksResponse>();

    const getLinks = useCallback(async () => {
        try {
            const _links = await client.listLinks(roomId);
            setLinks(_links);
        }
        catch (e) {
            console.error(e);
            setError(
                'Could not get linked channels.'
                + ` ${e instanceof ProvisioningError ? e.message : ''}`
            );
        }
    }, [client, roomId]);

    useEffect(() => {
        getLinks();
    }, []);

    const [unlinkError, setUnlinkError] = useState('');
    const [isBusy, setIsBusy] = useState(false);

    const unlinkChannel = useCallback(async(channel: string, server: string) => {
        setIsBusy(true);
        setUnlinkError('');

        try {
            await client.unlink(roomId, channel, server);
        }
        catch (e) {
            console.error(e);
            setUnlinkError(
                'Could not unlink channel.'
                + ` ${e instanceof ProvisioningError ? e.message : ''}`
            );
        }
        finally {
            setIsBusy(false);
        }
        await getLinks();
    }, [client, roomId]);

    let content;
    if (links) {
        if (links.length > 0) {
            content = <>
                <div className="grid grid-cols-1 gap-2 my-2">
                    { links.map(l => <LinkedChannelItem
                        server={l.remote_room_server}
                        channel={l.remote_room_channel}
                        unlinkChannel={unlinkChannel}
                        disabled={isBusy}
                    />) }
                </div>
                { unlinkError && <Alerts.Danger>{ unlinkError }</Alerts.Danger> }
            </>;
        }
        else {
            content = <Text.Caption>No channels linked</Text.Caption>
        }
    }
    else if (error) {
        content = <Alerts.Danger>{ error }</Alerts.Danger>;
    }
    else {
        content = <Text.Caption>Loading...</Text.Caption>;
    }

    return <div className="mb-6">
        <Text.Title>Linked channels</Text.Title>
        { content }
    </div>;
}

const LinkChannelForm = ({
    client,
    server,
    roomId,
}: {
    client: IrcProvisioningClient
    server: string,
    roomId: string,
}) => {
    const [error, setError] = useState('');
    const [info, setInfo] = useState('');

    const [channel, setChannel] = useState('');
    const [operatorNick, setOperatorNick] = useState('');
    const [channelKey, setChannelKey] = useState('');

    const [isBusy, setIsBusy] = useState(false);

    const linkChannel = useCallback(async() => {
        setIsBusy(true);
        setError('');
        setInfo('');
        try {
            const _channel = channel.startsWith('#') ? channel : `#${channel}`;
            await client.requestLink(
                server,
                _channel,
                roomId,
                operatorNick,
                channelKey,
            );
            setInfo(`Request to link ${server}/${_channel} was sent`);
        }
        catch (e) {
            console.error(e);
            setError(
                'Could not request link.'
                + ` ${e instanceof ProvisioningError ? e.message : ''}`
            );
        }
        finally {
            setIsBusy(false);
        }
    }, [client, server, channel, operatorNick, channelKey]);

    const isFormValid = channel.length > 0 && operatorNick.length > 0;

    return <div className="grid grid-cols-1 gap-4 my-2">
        <Forms.Input
            label="Channel"
            comment="Entering a channel will cause the bot to join it"
            placeholder="#"
            type="text"
            value={channel}
            onChange={e => setChannel(e.target.value)}
            disabled={isBusy}
        />
        <Forms.Input
            label="Channel operator nick"
            type="text"
            value={operatorNick}
            onChange={e => setOperatorNick(e.target.value)}
            disabled={isBusy}
        />
        <Forms.Input
            label="Channel key (optional)"
            type="text"
            value={channelKey}
            onChange={e => setChannelKey(e.target.value)}
            disabled={isBusy}
        />
        <Buttons.Primary onClick={linkChannel} disabled={!isFormValid || isBusy}>
            Request link
        </Buttons.Primary>
        { error && <Alerts.Danger>{ error }</Alerts.Danger> }
        { info && <Alerts.Success>{ info }</Alerts.Success> }
    </div>;
}

const AvailableChannels = ({
    client,
    roomId,
}: {
    client: IrcProvisioningClient
    roomId: string,
}) => {
    const [error, setError] = useState('');

    const [networks, setNetworks] = useState<QueryNetworksResponse>();

    useEffect(() => {
        const getNetworks = async() => {
            try {
                const _networks = await client.queryNetworks();
                setNetworks(_networks);
            }
            catch (e) {
                console.error(e);
                setError(
                    'Could not get networks.'
                    + ` ${e instanceof ProvisioningError ? e.message : ''}`
                );
            }
        };
        getNetworks();
    }, [client]);

    const [selectedServer, setSelectedServer] = useState('');

    let content;
    if (networks) {
        if (networks.servers.length > 0) {
            content = <>
                <Forms.Select
                    label="Server"
                    value={selectedServer}
                    onChange={e => setSelectedServer(e.target.value)}
                >
                    <option value="" key="blank">Select a server</option>
                    { networks.servers.map(server =>
                        <option value={server.network_id}>
                            { server.desc }
                        </option>
                    ) }
                </Forms.Select>
                { selectedServer &&
                    <LinkChannelForm
                        client={client}
                        server={selectedServer}
                        roomId={roomId}
                    />
                }
            </>;
        }
        else {
            content = <Text.Caption>No networks available</Text.Caption>
        }
    }
    else if (error) {
        content = <Alerts.Danger>{ error }</Alerts.Danger>;
    }
    else {
        content = <Text.Caption>Loading...</Text.Caption>;
    }

    return <div className="mb-6">
        <Text.Title>Link a new channel</Text.Title>
        { content }
    </div>;
}

export const IrcApp = () => {
    const provisioningContext = useProvisioningContext();

    const client = new IrcProvisioningClient(provisioningContext.client);

    return <div className="p-4">
        <LinkedChannels client={client} roomId={provisioningContext.roomId}/>
        <AvailableChannels client={client} roomId={provisioningContext.roomId}/>
    </div>;
}
