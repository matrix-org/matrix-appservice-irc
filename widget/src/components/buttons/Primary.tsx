import React from 'react';
import classNames from 'classnames';

const Primary = (props: React.ComponentPropsWithoutRef<'button'>) =>
    <button
        {...props}
        className={classNames(
            'px-4', 'py-2', 'rounded-lg',
            'bg-green', 'hover:bg-green-alt', 'disabled:bg-green', 'disabled:opacity-30', 'text-white',
            'transition',
            'cursor-pointer', 'disabled:cursor-not-allowed',
            props.className,
        )}
    />;

export { Primary };
