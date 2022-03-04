import { h } from "preact";
import { useState, useEffect } from 'preact/hooks';
import { UserStatusNetworkResponse } from "../../../src/provisioning/Schema";
import BridgeAPI from "../../BridgeAPI";
import Button from "../Button";
import style from "./IRCConfig.module.scss";

export default function IRCConfig(props: {network: string, niceName: string, bridgeApi: BridgeAPI}) {
    const [busy, setBusy] = useState<boolean>(true);
    const [status, setStatus] = useState<UserStatusNetworkResponse>(null);
    useEffect(() => {
        props.bridgeApi.userStatus(props.network).then(networksRes => {
            setBusy(false);
            setStatus(networksRes);
        }).catch(ex => {
            console.error(ex);
        })
    }, [setBusy, setStatus]);

    if (busy) {
        return <div className="spinner"/>;
    }

    let connectedStatement = null;
    if (status.connected) {
        connectedStatement = <p>
            You are connected to the <strong>{props.niceName}</strong> network as <code>{status.nick}</code>.
            <p>
                Your IP address is <code>{status.ipAddress}</code>
            </p>
        </p>;
    }
    else {
        connectedStatement = <p>You are not connected to IRC</p>;
    }

    return <main className={style.main}>
        <section>
            <h2>Info</h2>
            <p className={style.description}> Information about your connection to this network</p>
            {connectedStatement}
        </section>
        <section>
            <h2>Server Settings</h2>
            <p className={style.description}> Authentication options and connection management</p>
            <div className={style.inputField}>
                <label>Username</label>
                <input type="text" value={status.username || ""}></input>
            </div>
            <div className={style.inputField}>
                <label>Password</label>
                <input type="password"></input>
            </div>
            <Button>Reconnect</Button>
            <Button color="warning">Remove Password</Button>
        </section>
        <section>
            <h2>Rooms</h2>
            <p className={style.description}> All the rooms are you connected to!</p>
            <ul>
                {status.roomChannels?.map(t => <li>{t.channel} -- {t.room}</li>)}
            </ul>
        </section>
        <section>
            <h2>Actions</h2>
            <p className={style.description}> If this was done, there would be some actions to play with!</p>
        </section>
        <section>
            <h2>Management</h2>
            <p className={style.description}> This would be an administrative section</p>
        </section>
    </main>
}