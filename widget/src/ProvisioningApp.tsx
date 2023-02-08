import React, { createContext, useEffect, useMemo, useState } from 'react';
import { WidgetApi, WidgetApiToWidgetAction } from 'matrix-widget-api';
import urlJoin from 'url-join';

import { ProvisioningClient, ProvisioningError } from './ProvisioningClient';
import * as Text from './components/text';

type EmbedTypes = 'integration-manager' | 'default';

interface ProvisioningContext {
    client: ProvisioningClient,
    roomId: string,
    widgetId: string,
    embedType: EmbedTypes,
}

const Context = createContext<ProvisioningContext | undefined>(undefined);

export const useProvisioningContext = (): ProvisioningContext => {
    const context = React.useContext(Context);
    if (context === undefined) {
        throw new Error('ProvisioningContext must be used within the ProvisioningApp');
    }
    return context;
};

/**
 * @param apiPrefix Base path for API requests.
 * @param tokenName Name to use for the session token in localstorage.
 * @param children
 * @constructor
 */
export const ProvisioningApp: React.FC<React.PropsWithChildren<{
    apiPrefix: string,
    tokenName: string,
}>> = ({
   apiPrefix,
   tokenName,
   children,
}) => {
    const [error, setError] = useState<string>();

    // Parse parameters from query string
    const [widgetId, setWidgetId] = useState<string>();
    const [roomId, setRoomId] = useState<string>();
    const [embedType, setEmbedType] = useState<EmbedTypes>('default');
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);

        const widgetId = params.get('widgetId');
        if (!widgetId) {
            console.error(`Missing widgetId in query`);
            setError('Missing parameters');
            return;
        }
        setWidgetId(widgetId);

        const roomId = params.get('roomId');
        if (!roomId) {
            console.error(`Missing roomId in query`);
            setError('Missing parameters');
            return;
        }
        setRoomId(roomId);

        const embedType = params.get('io_element_embed_type');
        if (embedType === 'integration-manager') {
            setEmbedType(embedType);
        }
    }, []);

    // Set up widget API
    const [widgetApi, setWidgetApi] = useState<WidgetApi>();
    useEffect(() => {
        if (!widgetId) {
            return;
        }

        const widgetApi = new WidgetApi(widgetId);
        widgetApi.on('ready', () => {
            console.log('Widget API ready');
        });
        widgetApi.on(`action:${WidgetApiToWidgetAction.NotifyCapabilities}`, (ev) => {
            console.log(`${WidgetApiToWidgetAction.NotifyCapabilities}`, ev);
        });
        widgetApi.on(`action:${WidgetApiToWidgetAction.SendEvent}`, (ev) => {
            console.log(`${WidgetApiToWidgetAction.SendEvent}`, ev);
        });
        widgetApi.start();
        setWidgetApi(widgetApi);
    }, [widgetId]);

    // Set up provisioning client
    const [client, setClient] = useState<ProvisioningClient>();
    useEffect(() => {
        if (!widgetApi) {
            return;
        }

        // Assuming the widget is hosted on the same origin as the API
        const apiBaseUrl = urlJoin(window.location.origin, apiPrefix);

        const initClient = async() => {
            try {
                const client = await ProvisioningClient.create(
                    apiBaseUrl,
                    tokenName,
                    widgetApi,
                );
                setClient(client);
            } catch (e) {
                console.error('Failed to create Provisioning API client:', e);
                let message;
                if (e instanceof ProvisioningError) {
                    message = e.message;
                }
                setError(`Could not authenticate${message ? ': ' + message : ''}`);
            }
        };
        void initClient();
    }, [apiPrefix, tokenName, widgetApi]);

    const provisioningContext: ProvisioningContext | undefined = useMemo(() => {
        if (!client || !roomId || !widgetId) {
            return undefined;
        }
        return {
            client,
            roomId,
            widgetId,
            embedType,
        };
    }, [client, roomId, widgetId, embedType]);

    let content;
    if (provisioningContext) {
        content =
            <Context.Provider value={provisioningContext}>
                { children }
            </Context.Provider>;
    } else if (error) {
        content = <>
            <Text.Title>Something went wrong</Text.Title>
            <Text.Caption>{ error }</Text.Caption>
        </>;
    } else {
        content = <Text.Caption>Loading...</Text.Caption>;
    }

    return <div className={embedType === 'integration-manager' ? '' : 'p-4'}>
        { content }
    </div>;
};
