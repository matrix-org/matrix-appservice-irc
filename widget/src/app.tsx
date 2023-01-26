import React from 'react';
import { ProvisioningApp } from './ProvisioningApp';
import { IrcApp } from './IrcApp';

const App = () => {
    return <ProvisioningApp apiPrefix="/_matrix/provision">
        <IrcApp/>
    </ProvisioningApp>;
}

export default App;
