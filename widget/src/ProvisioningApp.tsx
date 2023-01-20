import React, {createContext, useEffect, useMemo, useState} from 'preact/compat';
import { WidgetApi, WidgetApiToWidgetAction } from 'matrix-widget-api';
import urlJoin from 'url-join';

import { ProvisioningClient, ProvisioningError } from './ProvisioningClient';

const ProvisioningContext = createContext<{
    client: ProvisioningClient,
    roomId: string,
    widgetId: string,
}>(undefined);

export const useProvisioningContext = () => {
    const context = React.useContext(ProvisioningContext);
    if (context === undefined) {
        throw new Error('ProvisioningContext must be used within the ProvisioningApp');
    }
    return context;
};

export const ProvisioningApp: React.FC<React.PropsWithChildren> = ({ children }) => {
    const [error, setError] = useState<string>();

    // Assuming the widget is hosted on the same origin as the API
    // TODO Use apiPrefix from bridge config
    const apiBaseUrl = urlJoin(window.location.origin, '/_matrix/provision');

    // Parse parameters from query string
    const [widgetId, setWidgetId] = useState<string>();
    const [roomId, setRoomId] = useState<string>();
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);

        const _widgetId = params.get('widgetId');
        if (!_widgetId) {
            console.error(`Missing widgetId in query`);
            setError('Missing parameters');
            return;
        }
        setWidgetId(_widgetId);

        const _roomId = params.get('roomId');
        if (!_roomId) {
            console.error(`Missing roomId in query`);
            setError('Missing parameters');
            return;
        }
        setRoomId(_roomId);
    }, []);

    // Set up widget API
    const [widgetApi, setWidgetApi] = useState<WidgetApi>();
    useEffect(() => {
        if (!widgetId) {
            return;
        }

        const _widgetApi = new WidgetApi(widgetId);
        _widgetApi.on('ready', () => {
            console.log('Widget API ready');
        });
        _widgetApi.on(`action:${WidgetApiToWidgetAction.NotifyCapabilities}`, (ev) => {
            console.log(`${WidgetApiToWidgetAction.NotifyCapabilities}`, ev);
        })
        _widgetApi.on(`action:${WidgetApiToWidgetAction.SendEvent}`, (ev) => {
            console.log(`${WidgetApiToWidgetAction.SendEvent}`, ev);
        })
        _widgetApi.start();
        setWidgetApi(_widgetApi);
    }, [widgetId]);

    // Set up provisioning client
    const [client, setClient] = useState<ProvisioningClient>();
    useEffect(() => {
        if (!widgetApi) {
            return;
        }

        const initClient = async() => {
            try {
                const _client = await ProvisioningClient.create(apiBaseUrl, widgetApi);
                setClient(_client);
            }
            catch (e) {
                console.error('Failed to create Provisioning API client:', e);
                let message;
                if (e instanceof ProvisioningError) {
                    message = e.message;
                }
                setError(`Could not authenticate${message ? ': ' + message : ''}`);
            }
        };
        initClient();
    }, [apiBaseUrl, widgetApi]);

    const provisioningContext = useMemo(() => ({
        widgetId,
        roomId,
        client,
    }), [widgetId, roomId, client]);

    if (client) {
        return <ProvisioningContext.Provider value={provisioningContext}>
            { children }
        </ProvisioningContext.Provider>;
    }
    else if (error) {
        return <>
            <h3>Something went wrong</h3>
            <p>{ error }</p>
        </>;
    }
    return <>
        <h3>Loading...</h3>
    </>;
}
