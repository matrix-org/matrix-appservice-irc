import React from 'react';
import classNames from 'classnames';

const Outline = ({
    color = 'primary',
    size = 'large',
    ...props
}: React.ComponentPropsWithoutRef<'button'> & {
    color?: 'primary' | 'danger',
    size?: 'large' | 'small',
}) =>
    <button
        {...props}
        className={classNames(
            {
                'px-12 py-3 rounded-lg': size === 'large',
                'px-3 py-1 rounded-lg': size === 'small',
                'bg-green bg-opacity-0 hover:bg-opacity-10 text-green border border-green': color === 'primary',
                'bg-red bg-opacity-0 hover:bg-opacity-10 text-red border border-red': color === 'danger',
            },
            'disabled:border-grey-100', 'disabled:text-grey-100',
            'focus:border-grey-100', 'focus:ring-0',
            'transition',
            'cursor-pointer', 'disabled:cursor-not-allowed',
            props.className,
        )}
    />;

export { Outline };
