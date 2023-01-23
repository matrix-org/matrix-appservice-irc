import React from 'preact/compat';
import { ProvisioningApp } from './ProvisioningApp';
import { IrcApp } from "./IrcApp";

export const App = () => {
    return <ProvisioningApp apiPrefix="/_matrix/provision">
        <IrcApp/>
    </ProvisioningApp>;
}
