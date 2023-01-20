import React from 'preact';
import classNames from 'classnames';

const Danger = (props: React.ComponentProps<'div'>) =>
    <div
        {...props}
        className={classNames(
            'px-4', 'py-2', 'rounded-lg',
            'bg-red', 'bg-opacity-40',
            'text-black-900', 'text-opacity-80',
            props.className as string
        )}
    />;

export { Danger };
