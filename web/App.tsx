/* eslint-disable no-console */
import { h, Component } from 'preact';
import WA from 'matrix-widget-api';
import BridgeAPI from './BridgeAPI';
import ErrorPane from './components/ErrorPane';
import { WidgetKind } from './WidgetKind';
import InviteView from './components/InviteView';
import AdminSettings from "./components/AdminSettings";

interface EarlyState {
    error: string|null,
    busy: boolean,
    roomId: undefined,
    kind: undefined,
    widgetApi: undefined,
    bridgeApi: undefined,
}

interface CompleteState {
    error: string|null,
    busy: boolean,
    roomId: string,
    kind: WidgetKind,
    widgetApi: WA.WidgetApi,
    bridgeApi: BridgeAPI,
}

function parseFragment() {
    const fragmentString = (window.location.hash || "?");
    return new URLSearchParams(fragmentString.substring(Math.max(fragmentString.indexOf('?'), 0)));
}

function assertParam(fragment, name) {
    const val = fragment.get(name);
    if (!val) throw new Error(`${name} is not present in URL - cannot load widget`);
    return val;
}

export default class App extends Component<void, EarlyState|CompleteState> {

    constructor() {
        super();
        this.state = {
            error: null,
            busy: true,
            roomId: undefined,
            kind: undefined,
            widgetApi: undefined,
            bridgeApi: undefined,
        };
    }

    async componentDidMount() {
        try {
        // Start widgeting
            const qs = parseFragment();
            const widgetId = assertParam(qs, 'widgetId');
            const roomId = assertParam(qs, 'roomId');
            const isInviteWidget = qs.get('bridgeInvites') === 'true';
            // Fetch via config.
            const widgetApi = new WA.WidgetApi(widgetId);
            widgetApi.on("ready", () => {
                console.log("Widget ready:", this);
            });
            widgetApi.on(`action:${WA.WidgetApiToWidgetAction.NotifyCapabilities}`, (ev) => {
                console.log(ev.detail.data.approved);
                console.log(`${WA.WidgetApiToWidgetAction.NotifyCapabilities}`, ev);
            })
            widgetApi.on(`action:${WA.WidgetApiToWidgetAction.SendEvent}`, (ev) => {
                console.log(`${WA.WidgetApiToWidgetAction.SendEvent}`, ev);
            })
            // Start the widget as soon as possible too, otherwise the client might time us out.
            widgetApi.start();
            const bridgeApi = await BridgeAPI.getBridgeAPI("http://127.0.0.1:6002/_matrix/provision", widgetApi);
            await bridgeApi.verify();
            this.setState({
                roomId,
                kind: isInviteWidget ? WidgetKind.BridgeInvites : WidgetKind.Settings,
                busy: false,
                widgetApi,
                bridgeApi,
            });
        } catch (ex) {
            console.error(`Bridge verifiation failed:`, ex);
            this.setState({
                error: ex,
                busy: false,
            });
        }
    }

    render() {
        // Return the App component.
        let content;
        if (this.state.error) {
            content = <ErrorPane>{this.state.error}</ErrorPane>;
        }
        else if (this.state.busy) {
            content = <div class="spinner"></div>;
        }
        else if (this.state.kind === WidgetKind.Settings) {
            content = <AdminSettings bridgeApi={this.state.bridgeApi}></AdminSettings>;
        }
        else if (this.state.bridgeApi && this.state.widgetApi && this.state.kind === WidgetKind.BridgeInvites) {
            content = <InviteView bridgeApi={this.state.bridgeApi} widgetApi={this.state.widgetApi} ></InviteView>;
        }
        else {
            content = <ErrorPane>{new Error('Invalid state')}</ErrorPane>;
        }

        return <div className="App">{content}</div>;
    }
}
