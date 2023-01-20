import { ExchangeOpenAPIRequestBody, ExchangeOpenAPIResponseBody } from 'matrix-appservice-bridge';
import { WidgetApi } from 'matrix-widget-api';
import urlJoin from 'url-join';

export class ProvisioningError extends Error {
    constructor(
        readonly errcode: string,
        readonly error: string,
    ) {
        super(`Error ${errcode}: ${error}`);
    }
}

async function parseError(req: Response) {
    let errBody;
    try {
        errBody = await req.json();
    }
    catch (e) {
        // Response body may not be JSON
        return new Error('Request failed');
    }

    const maybe = errBody as ProvisioningError;
    if (
        maybe
        && typeof maybe === 'object'
        && typeof maybe.errcode === 'string'
        && typeof maybe.error === 'string'
    ) {
        return new ProvisioningError(
            maybe.errcode,
            maybe.error,
        );
    }
    return new Error('Request failed');
}

export class ProvisioningClient {
    static async create(baseUrl: string, widgetApi: WidgetApi): Promise<ProvisioningClient> {
        // Check if there is already a session token
        const sessionToken = localStorage.getItem('irc-sessionToken');
        if (sessionToken) {
            const client = new ProvisioningClient(baseUrl, sessionToken);
            try {
                await client.verify();
                return client;
            }
            catch (e) {
                if (e instanceof ProvisioningError && e.errcode === 'M_AS_BAD_TOKEN') {
                    // Token needs to be refreshed
                    console.info('Failed to verify session token');
                    localStorage.removeItem(sessionToken);
                }
                else {
                    throw e;
                }
            }
        }

        // Get OpenID credentials from homeserver
        // TODO Handle if user rejects prompt
        const credentials = await widgetApi.requestOpenIDConnectToken();
        const { matrix_server_name, access_token } = credentials;
        if (!matrix_server_name || !access_token) {
            throw new Error('Missing values in OpenID credentials response');
        }

        // Exchange OpenID credentials for Provisioning API session token
        const reqBody: ExchangeOpenAPIRequestBody = {
            matrixServer: matrix_server_name,
            openIdToken: access_token,
        };
        const res = await fetch(
            urlJoin(baseUrl, '/v1/exchange_openid'),
            {
                cache: 'no-cache',
                method: 'POST',
                body: JSON.stringify(reqBody),
                headers: {
                    'Content-Type': 'application/json',
                },
            },
        );
        if (!res.ok) {
            throw await parseError(res);
        }
        const resBody = await res.json() as ExchangeOpenAPIResponseBody;
        localStorage.setItem('irc-sessionToken', resBody.token);
        console.info('Stored new session token');
        return new ProvisioningClient(baseUrl, resBody.token);
    }

    private constructor(
        readonly baseUrl: string,
        readonly sessionToken: string,
    ) {}

    async request(
        method: string,
        path: string,
        body?: unknown,
    ): Promise<unknown> {
        const res = await fetch(
            urlJoin(this.baseUrl, path),
            {
                cache: 'no-cache',
                method,
                body: body ? JSON.stringify(body) : null,
                headers: {
                    Authorization: `Bearer ${this.sessionToken}`,
                    // Only set Content-Type if we send a body
                    ...(!!body && {
                        'Content-Type': 'application/json',
                    }),
                },
            },
        );
        if (!res.ok) {
            throw await parseError(res);
        }
        return (await res.json() as unknown);
    }

    async verify(): Promise<{ userId: string, type: string }> {
        const res = await this.request('GET', `/v1/session`);
        return res as { userId: string, type: string };
    }
}
