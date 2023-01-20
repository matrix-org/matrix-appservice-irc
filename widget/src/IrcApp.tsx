import React, {useCallback, useEffect, useState} from 'preact/compat';

import { useProvisioningContext } from './ProvisioningApp';
import { ProvisioningError } from './ProvisioningClient';
import { IrcProvisioningClient, ListLinksResponse, QueryNetworksResponse } from './IrcProvisioningClient';

const LinkedChannels = ({
    ircProvisioningClient,
    roomId,
}: {
    ircProvisioningClient: IrcProvisioningClient
    roomId: string,
}) => {
    const [error, setError] = useState('');

    const [links, setLinks] = useState<ListLinksResponse>();

    const getLinks = useCallback(async () => {
        try {
            const _links = await ircProvisioningClient.listLinks(roomId);
            setLinks(_links);
        }
        catch (e) {
            console.error(e);
            let message;
            if (e instanceof ProvisioningError) {
                message = e.message;
            }
            setError(`Could not get linked channels${message ? ': ' + message : ''}`);
        }
    }, [ircProvisioningClient, roomId]);

    useEffect(() => {
        getLinks();
    }, []);

    const unlinkChannel = useCallback(async(channel: string, server: string) => {
        console.debug(`Unlinking ${server}/${channel}`);
        try {
            await ircProvisioningClient.unlink(roomId, channel, server);
        }
        catch (e) {
            console.error(e);
            // TODO Display unlink error
        }
        await getLinks();
    }, [ircProvisioningClient, roomId]);

    let content;
    if (links) {
        if (links.length > 0) {
            content = links.map(l =>
                <div key={`${l.remote_room_server}/${l.remote_room_channel}`}>
                    <p>{l.remote_room_server}/{l.remote_room_channel}</p>
                    <button onClick={() => unlinkChannel(l.remote_room_channel, l.remote_room_server)}>
                        Unlink
                    </button>
                </div>
            );
        }
        else {
            content = <p>No channels linked</p>
        }
    }
    else if (error) {
        content = <>
            <h3>Something went wrong</h3>
            <p>{ error }</p>
        </>;
    }
    else {
        content = <p>Loading...</p>;
    }

    return <>
        <h2>Linked channels</h2>
        { content }
    </>;
}

const AvailableChannels = ({
    ircProvisioningClient,
    roomId,
}: {
    ircProvisioningClient: IrcProvisioningClient
    roomId: string,
}) => {
    const [error, setError] = useState('');

    const [networks, setNetworks] = useState<QueryNetworksResponse>();

    useEffect(() => {
        const getNetworks = async() => {
            try {
                const _networks = await ircProvisioningClient.queryNetworks();
                setNetworks(_networks);
            }
            catch (e) {
                console.error(e);
                let message;
                if (e instanceof ProvisioningError) {
                    message = e.message;
                }
                setError(`Could not get networks${message ? ': ' + message : ''}`);
            }
        };
        getNetworks();
    }, [ircProvisioningClient]);

    const [selectedServer, setSelectedServer] = useState('');

    let content;
    if (networks) {
        if (networks.servers.length > 0) {
            content = <>
                <label>
                   Server:
                    <select value={selectedServer} onChange={e => setSelectedServer(e.target.value)}>
                        <option value="" key="blank">Select a server</option>
                        { networks.servers.map(server =>
                            <option value={server.network_id}>
                                { server.desc }
                            </option>
                        ) }
                    </select>
                </label>
                { selectedServer &&
                    <LinkChannelForm
                        ircProvisioningClient={ircProvisioningClient}
                        server={selectedServer}
                        roomId={roomId}
                    />
                }
            </>;
        }
        else {
            content = <p>No networks available</p>
        }
    }
    else if (error) {
        content = <>
            <h3>Something went wrong</h3>
            <p>{ error }</p>
        </>;
    }
    else {
        content = <p>Loading...</p>;
    }

    return <>
        <h2>Link a new channel</h2>
        { content }
    </>;
}

const LinkChannelForm = ({
    ircProvisioningClient,
    server,
    roomId,
}: {
    ircProvisioningClient: IrcProvisioningClient
    server: string,
    roomId: string,
}) => {
    const [error, setError] = useState('');

    const [channel, setChannel] = useState('');
    const [operatorNick, setOperatorNick] = useState('');
    const [channelKey, setChannelKey] = useState('');

    const linkChannel = useCallback(async() => {
        try {
            await ircProvisioningClient.requestLink(
                server,
                channel,
                roomId,
                operatorNick,
                channelKey,
            );
        }
        catch (e) {
            console.error(e);
            let message;
            if (e instanceof ProvisioningError) {
                message = e.message;
            }
            setError(`Could not request link${message ? ': ' + message : ''}`);
        }
    }, [ircProvisioningClient, server, channel, operatorNick, channelKey]);

    return <div>
        { error && <>
            <h3>Something went wrong</h3>
            <p>{ error }</p>
        </> }
        <label>
            Channel:
            <input type="text" value={channel} onChange={e => setChannel(e.target.value)} />
            Entering a channel will cause the bot to join it.
        </label>
        <label>
            Channel Operator Nick:
            <input type="text" value={operatorNick} onChange={e => setOperatorNick(e.target.value)} />
        </label>
        <label>
            Channel Key (optional)
            <input type="text" value={channelKey} onChange={e => setChannelKey(e.target.value)} />
        </label>
        <button onClick={linkChannel}>
            Request link
        </button>
    </div>;
}

export const IrcApp = () => {
    const provisioningContext = useProvisioningContext();

    const client = new IrcProvisioningClient(provisioningContext.client);

    return <>
        <h1>IRC Bridge</h1>
        <p>Room ID: {provisioningContext.roomId}</p>
        <p>Widget ID: {provisioningContext.widgetId}</p>
        <LinkedChannels ircProvisioningClient={client} roomId={provisioningContext.roomId}/>
        <AvailableChannels ircProvisioningClient={client} roomId={provisioningContext.roomId}/>
    </>;
}
