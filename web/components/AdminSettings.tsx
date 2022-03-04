import { h } from "preact";
import { useEffect, useState, useCallback } from 'preact/hooks';
import GeneralConfig from './configs/GeneralConfig';
import style from "./AdminSettings.module.scss";
import BridgeAPI from "../BridgeAPI";
import IRCConfig from "./configs/IRCConfig";

interface IProps {
    bridgeApi: BridgeAPI;
}

export default function AdminSettings(props: IProps) {
    const [currentTab, setCurrentTab] = useState<string>("general");
    const [busy, setBusy] = useState<boolean>(true);
    const [networks, setNetworks] = useState<{servers: {network_id: string, desc: string}[]}>(null);
    useEffect(() => {
        props.bridgeApi.queryNetworks().then(networksRes => {
            setNetworks(networksRes);
        })
        setBusy(false);
    }, [setBusy, setNetworks]);
    if (busy) {
        return <div className={style.root}>
            <div className="spinner"/>
        </div>;
    }
    const onSectionClick = useCallback(
        (event: MouseEventHandler<HTMLAnchorElement>) => {
            const key = (event.target as HTMLElement).parentElement.getAttribute('sectionkey');
            setCurrentTab(key);
        },
        [setCurrentTab]
    );
    return <div className={style.root}>
        <h1 className={style.header}> IRC Bridge Settings</h1>
        <section className={style.contents}>
            <aside className={style.sidebar}>
                <ul>
                    <a sectionKey="general" onClick={onSectionClick}>
                        <li className={currentTab === "general" ? style.active : null}>General</li>
                    </a>
                    {!networks && <span><span>Loading networks</span><div className="spinner"></div></span>}
                    {networks?.servers.map(n => <a sectionKey={n.network_id} onClick={onSectionClick}>
                        <li className={currentTab === n.network_id ? style.active : null}>{n.desc}</li>
                    </a>)}
                </ul>
            </aside>
            <section className={style.content}>
                {currentTab === "general" && <GeneralConfig/>}
                {currentTab !== "general" && <IRCConfig network={currentTab} niceName={networks.servers.find(s => s.network_id === currentTab).desc} bridgeApi={this.props.bridgeApi} />}
            </section>
        </section>
    </div>;
}