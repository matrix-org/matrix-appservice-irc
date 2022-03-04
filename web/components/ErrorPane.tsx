import { h, FunctionComponent } from "preact";
import { BridgeAPIError } from "../BridgeAPI";
import style from "./ErrorPane.module.scss";

interface Error {
    error: string;
    errcode: string;
}

const ErrorPane: FunctionComponent<unknown> = ({ children }) => {
    const error = children as BridgeAPIError|Error;
    return <div className={`card error ${style.errorPane}`}>
        <h3>A fatal error occured</h3>
        <p> {error?.error || error.message || error} </p>
        {error.errcode && <small>{error.errcode}</small>}
    </div>;
};

export default ErrorPane;
