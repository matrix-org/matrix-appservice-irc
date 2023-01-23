import React from 'preact';
import classNames from 'classnames';

const Success = (props: React.ComponentProps<'div'>) =>
    <div
        {...props}
        className={classNames(
            'px-4', 'py-2', 'rounded-lg',
            'bg-green', 'bg-opacity-30',
            'text-black-900', 'text-opacity-70',
            props.className as string
        )}
    />;

export { Success };
