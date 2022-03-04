import { h } from "preact";
import { useState } from 'preact/hooks';
import Button from "../Button";

export default function GeneralConfig() {
    return <section>
        <div>
            <p>Bridge Version: <span>0.32.0</span></p>
        </div>
        <div>
            <Button color="warning">Quit all rooms</Button>
        </div>
    </section>
}