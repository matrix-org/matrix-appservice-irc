import React from 'react';
import { ProvisioningApp } from './ProvisioningApp';
import { IrcApp } from './IrcApp';

const App = () => {
    return <ProvisioningApp
        tokenName="irc-sessionToken"
    >
        <IrcApp/>
    </ProvisioningApp>;
}

export default App;
