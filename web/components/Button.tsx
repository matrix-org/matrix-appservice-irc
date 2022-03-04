import { h } from "preact";
import style from "./Button.module.scss";

export default function Button(props: {children?: string, color?: "info"|"warning", onClick?: (event: MouseEvent) => void}) {
    return <button className={`${style.button} ${style[props.color || "info"]}`} onClick={props.onClick}>
        {props.children}
    </button>
}