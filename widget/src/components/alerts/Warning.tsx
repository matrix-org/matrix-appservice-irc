import React from 'react';
import classNames from 'classnames';

import * as Icons from '../icons';

const Warning = (props: React.ComponentPropsWithoutRef<'div'>) =>
    <div
        {...props}
        className={classNames(
            'p-4', 'rounded-lg',
            'border', 'border-grey-50',
            'flex', 'items-center',
            props.className,
        )}
    >
        <div className="p-2 bg-grey-25 mr-4 rounded-lg">
            <Icons.Alert/>
        </div>
        { props.children }
    </div>;

export { Warning };
