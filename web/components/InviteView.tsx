import { WidgetApi } from "matrix-widget-api";
import { h } from "preact";
import { useCallback, useState } from "preact/hooks"
import BridgeAPI from "../BridgeAPI";
import style from "./InviteView.module.scss";
import { Bars } from  'react-loader-spinner'

interface IProps {
    widgetApi: WidgetApi,
    bridgeApi: BridgeAPI,
}


const DEBOUNCE_FOR_MS = 500;

function InviteViewItem(props: {onUserSelect: (data: {displayName, userId, avatarMxc}) => void, userId: string, displayName?: string, avatarMxc?: string, rawAvatarUrl?: string}) {
    const { onUserSelect, userId, displayName, avatarMxc, rawAvatarUrl } = props;

    const onUserSelectCb = useCallback((ev: Event) => {
        ev.preventDefault();
        onUserSelect({displayName, userId, avatarMxc});
    }, []);

    return <li className={style.userItem}>
        <img className={style.avatar} src={ rawAvatarUrl || "/placehold.it/36"}/>
        <a title={userId} className={style.identifiers} href="#" onClick={onUserSelectCb} data-user={JSON.stringify({displayName, userId, avatarMxc})}>
            <span className="displayName">{displayName || userId}</span>
        </a>
    </li>;
}

export default function InviteView(props: IProps) {
    const [debounceTimer, setDebounceTimer] = useState<NodeJS.Timeout|null>();
    const [searchResults, setSearchResults] = useState<UserSearchResults|null>();

    const onSubmit = useCallback((ev) => {
        ev.preventDefault();
    }, []);

    const onInputChange = useCallback((ev: Event) => {
        ev.preventDefault();

        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }

        const currentText = (ev.target as HTMLInputElement).value.trim();
        if (!currentText) {
            setDebounceTimer(null);
            return;
        }

        setDebounceTimer(setTimeout(() => {
            setDebounceTimer(null);
            const text = (ev.target as HTMLInputElement).value.trim();
            if (!text) {
                return;
            }
            props.bridgeApi.searchUsers(text).then((results) => {
                setSearchResults(results);
            }).catch(ex => {
                setSearchResults(null);
                console.error("Failed to search for users", ex);
            });
        }, DEBOUNCE_FOR_MS));
    }, [debounceTimer, setDebounceTimer, searchResults, setSearchResults]);


    const onUserSelect = useCallback((data: {displayName, userId, avatarMxc}) => {
        props.widgetApi.transport.send("invite_candidate", data).catch((ex) => {
            // TODO: Bubble up error
            console.error("Failed to send candidate over widgetApi", ex);
        });
    }, []);

    console.log("Rendering ", searchResults);


    return <div>
        <form className={style.form} onSubmit={onSubmit}>
            <input onInput={onInputChange} className={style.inputField} type="search" placeholder="Search for Slack users."/>
        </form>
        {debounceTimer && <span className={style.loading}><Bars heigth="100" width="100" color='grey' ariaLabel='loading'/></span>}
        {searchResults && <ul>
            {searchResults?.map((u) => <InviteViewItem key={u.userId} onUserSelect={onUserSelect} {...u}/>)}
        </ul>}
    </div>;
}