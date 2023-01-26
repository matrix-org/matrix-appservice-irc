import React from 'react';
import classNames from 'classnames';

const Danger = (props: React.ComponentPropsWithoutRef<'div'>) =>
    <div
        {...props}
        className={classNames(
            'px-4', 'py-2', 'rounded-lg',
            'bg-red', 'bg-opacity-30',
            'text-black-900', 'text-opacity-70',
            props.className,
        )}
    />;

export { Danger };
