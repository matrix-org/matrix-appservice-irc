import React from 'react';
import classNames from 'classnames';

const Card = (props: React.ComponentPropsWithoutRef<'div'>) =>
    <div
        {...props}
        className={classNames(
            'p-8', 'rounded-lg', 'bg-white', 'border', 'border-grey-50',
            props.className,
        )}
    />;

export { Card };
