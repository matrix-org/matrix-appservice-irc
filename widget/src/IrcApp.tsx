import React, { useCallback, useEffect, useRef, useState } from 'react';

import { useProvisioningContext } from './ProvisioningApp';
import { ProvisioningError } from './ProvisioningClient';
import { IrcProvisioningClient, ListLinksResponse, QueryNetworksResponse } from './IrcProvisioningClient';
import * as Text from './components/text';
import * as Buttons from './components/buttons';
import * as Forms from './components/forms';
import * as Alerts from './components/alerts';
import { Card, Rule } from './components/layout';

const pollLinkIntervalMs = 1000;

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
        className="flex justify-between items-center border border-grey-50 rounded-lg p-4"
        key={`${server}/${channel}`}
    >
        <Text.BodySemiBold>{ `${server}/${channel}` }</Text.BodySemiBold>
        <Buttons.Outline
            color="danger"
            size="small"
            onClick={unlink}
            disabled={disabled}
        >
            Unlink
        </Buttons.Outline>
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
        setError('');
        try {
            const links = await client.listLinks(roomId);
            setLinks(links);
        }
        catch (e) {
            console.error(e);
            setError(
                'Could not get linked channels.'
                + ` ${e instanceof ProvisioningError ? e.message : ''}`
            );
        }
    }, [client, roomId]);

    const pollTimerId = useRef<number>();
    useEffect(() => {
        const poll = async () => {
            try {
                await getLinks();
            }
            finally {
                // Recursively call poll
                pollTimerId.current = window.setTimeout(
                    poll,
                    pollLinkIntervalMs
                );
            }
        };
        void poll();

        // Cleanup
        return () => {
            window.clearTimeout(pollTimerId.current);
        };
    }, [getLinks]);

    const [unlinkError, setUnlinkError] = useState('');
    const [isBusy, setIsBusy] = useState(false);

    const unlinkChannel = useCallback(async(channel: string, server: string) => {
        setIsBusy(true);
        setUnlinkError('');

        try {
            await client.unlink(roomId, channel, server);
        } catch (e) {
            console.error(e);
            setUnlinkError(
                'Could not unlink channel.'
                + ` ${e instanceof ProvisioningError ? e.message : ''}`
            );
        } finally {
            setIsBusy(false);
        }
        await getLinks();
    }, [client, roomId, getLinks]);

    let content;
    if (links) {
        if (links.length > 0) {
            content = <>
                <div className="grid grid-cols-1 gap-2 my-2">
                    { links.map(l => <LinkedChannelItem
                        server={l.remote_room_server}
                        channel={l.remote_room_channel}
                        key={`${l.remote_room_server}/${l.remote_room_channel}`}
                        unlinkChannel={unlinkChannel}
                        disabled={isBusy}
                    />) }
                    { unlinkError && <Alerts.Warning>{ unlinkError }</Alerts.Warning> }
                    { error && <Alerts.Warning>{ error }</Alerts.Warning> }
                </div>
            </>;
        } else {
            content = <>
                <Text.Caption className="text-grey-200">
                    No channels are linked to this room.
                </Text.Caption>
                { error && <Alerts.Warning>{ error }</Alerts.Warning> }
            </>;
        }
    } else if (error) {
        content = <Alerts.Warning>{ error }</Alerts.Warning>;
    } else {
        content = <Text.Caption className="text-grey-200">
            Loading...
        </Text.Caption>;
    }

    return <div className="mb-6">
        <Text.SubtitleSemiBold>Linked channels</Text.SubtitleSemiBold>
        <Rule/>
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
    const [isBusy, setIsBusy] = useState(false);
    const [error, setError] = useState('');
    const [info, setInfo] = useState('');

    const [channel, setChannel] = useState('');
    const [operatorNick, setOperatorNick] = useState('');
    const [channelKey, setChannelKey] = useState('');

    const [isBusyOperatorNicks, setIsBusyOperatorNicks] = useState(false);
    const [operatorNicksInfo, setOperatorNicksInfo] = useState('');
    const [operatorNicks, setOperatorNicks] = useState<string[]>();

    const resetState = useCallback(() => {
        // Reset form state
        setChannel('');
        setOperatorNick('');
        setChannelKey('');
        setOperatorNicksInfo('');
        setOperatorNicks(undefined);
    }, []);

    const getOperatorNicks = useCallback(async() => {
        if (!channel || channel === '#') {
            return;
        }

        setIsBusyOperatorNicks(true);
        try {
            const ops = await client.queryLink(server, channel, channelKey)
            if (ops.operators.length > 0) {
                setOperatorNicksInfo(`Found ${ops.operators.length} operator(s) in this channel`);
            }
            else {
                setOperatorNicksInfo('No operators found in this channel');
            }
            setOperatorNicks(ops.operators);
        } catch (e) {
            console.error(e);
            setOperatorNicksInfo(
                'Could not get operator nicks.'
                + ` ${e instanceof ProvisioningError ? e.message : ''}`
            );
        } finally {
            setIsBusyOperatorNicks(false);
        }
    }, [client, server, channel, channelKey]);

    const linkChannel = useCallback(async() => {
        setIsBusy(true);
        setError('');
        setInfo('');
        try {
            await client.requestLink(
                server,
                channel,
                roomId,
                operatorNick,
                channelKey,
            );
            setInfo(`Request to link ${server}/${channel} was sent`);
            resetState();
        } catch (e) {
            console.error(e);
            setError(
                'Could not request link.'
                + ` ${e instanceof ProvisioningError ? e.message : ''}`
            );
        } finally {
            setIsBusy(false);
        }
    }, [client, server, channel, roomId, operatorNick, channelKey, resetState]);

    const isFormValid = channel.length > 0 && operatorNick.length > 0;

    const onChannelChange: React.ChangeEventHandler<HTMLInputElement> = useCallback((e) => {
        const channel = e.currentTarget.value;
        setChannel(channel.startsWith('#') ? channel : `#${channel}`);
    }, []);

    const onOperatorNickChange: React.ChangeEventHandler<HTMLInputElement> = useCallback((e) => {
        setOperatorNick(e.currentTarget.value);
    }, []);

    const onChannelKeyChange: React.ChangeEventHandler<HTMLInputElement> = useCallback((e) => {
        setChannelKey(e.currentTarget.value);
    }, []);

    return <>
        <Forms.Input
            label="Channel"
            comment="Entering a channel will cause the bot to join it"
            placeholder="#"
            type="text"
            value={channel}
            onChange={onChannelChange}
            onBlur={getOperatorNicks}
            disabled={isBusy}
        />
        <Forms.Input
            label="Channel operator nick"
            comment={isBusyOperatorNicks ? 'Loading operator nicks...' : operatorNicksInfo}
            type="text"
            value={operatorNick}
            list="operatorNicks"
            onChange={onOperatorNickChange}
            disabled={isBusy}
        />
        { operatorNicks &&
            <datalist id="operatorNicks">
                { operatorNicks.map(nick => <option value={nick} key={nick}></option>) }
            </datalist>
        }
        <Forms.Input
            label="Channel key (optional)"
            type="text"
            value={channelKey}
            onChange={onChannelKeyChange}
            onBlur={getOperatorNicks}
            disabled={isBusy}
        />
        <div className="col-span-full grid md:grid-cols-2 gap-4">
            <Text.Caption className="text-grey-200">
                Requesting a link will send a message to the operator for approval.
            </Text.Caption>
            <div className="flex justify-end">
                <Buttons.Solid onClick={linkChannel} disabled={!isFormValid || isBusy}>
                    Request link
                </Buttons.Solid>
            </div>
        </div>
        <div className="col-span-full">
            { error && <Alerts.Warning>{ error }</Alerts.Warning> }
        </div>
        <div className="col-span-full">
            { info && <Alerts.Success>{ info }</Alerts.Success> }
        </div>
    </>;
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
    const [selectedServer, setSelectedServer] = useState('');

    useEffect(() => {
        const getNetworks = async() => {
            try {
                const networks = await client.queryNetworks();
                setNetworks(networks);

                if (networks.servers.length === 1) {
                    setSelectedServer(networks.servers[0].fields.domain);
                }
            } catch (e) {
                console.error(e);
                setError(
                    'Could not get networks.'
                    + ` ${e instanceof ProvisioningError ? e.message : ''}`
                );
            }
        };
        void getNetworks();
    }, [client]);

    let content;
    if (networks) {
        if (networks.servers.length > 0) {
            content = <div className="grid md:grid-cols-2 gap-4 my-2">
                { networks.servers.length === 1
                    ? <Forms.Input
                        label="Server"
                        value={selectedServer}
                        disabled
                    />
                    : <Forms.Select
                        label="Server"
                        value={selectedServer}
                        onChange={e => setSelectedServer(e.target.value)}
                    >
                        <option value="" key="blank">Select a server</option>
                        { networks.servers.map(server =>
                            <option value={server.fields.domain} key={server.network_id}>
                                { server.desc }
                            </option>
                        ) }
                    </Forms.Select>
                }
                { selectedServer &&
                    <LinkChannelForm
                        client={client}
                        server={selectedServer}
                        roomId={roomId}
                    />
                }
            </div>;
        } else {
            content = <Text.Caption className="text-grey-200">
                No networks available
            </Text.Caption>
        }
    } else if (error) {
        content = <Alerts.Warning>{ error }</Alerts.Warning>;
    } else {
        content = <Text.Caption className="text-grey-200">
            Loading...
        </Text.Caption>;
    }

    return <div className="mb-6">
        <Text.SubtitleSemiBold>Link a new channel</Text.SubtitleSemiBold>
        <Rule/>
        { content }
    </div>;
}

export const IrcApp = () => {
    const provisioningContext = useProvisioningContext();

    const client = new IrcProvisioningClient(provisioningContext.client);

    return <div className="flex flex-col gap-4">
        <Card>
            <LinkedChannels client={client} roomId={provisioningContext.roomId}/>
        </Card>
        <Card>
            <AvailableChannels client={client} roomId={provisioningContext.roomId}/>
        </Card>
    </div>;
}
