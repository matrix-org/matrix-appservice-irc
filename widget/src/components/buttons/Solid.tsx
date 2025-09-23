import React from 'react';
import classNames from 'classnames';

const Solid = ({
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
                'px-5 py-1 rounded-lg': size === 'small',
                'bg-green hover:bg-green-alt text-white': color === 'primary',
                'bg-red hover:bg-red-alt text-white': color === 'danger',
            },
            'disabled:bg-grey-100',
            'border-none', 'focus:border-grey-100', 'focus:ring-0',
            'transition',
            'cursor-pointer', 'disabled:cursor-not-allowed',
            props.className,
        )}
    />;

export { Solid };
