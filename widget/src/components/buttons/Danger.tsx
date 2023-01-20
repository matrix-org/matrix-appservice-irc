import React from 'preact';
import classNames from 'classnames';

const Danger = (props: React.ComponentProps<'button'>) =>
    <button
        {...props}
        className={classNames(
            'px-4', 'py-2', 'rounded-lg',
            'bg-red', 'hover:bg-red-alt', 'disabled:bg-red', 'disabled:opacity-30', 'text-white',
            'border-none', 'focus:border-grey-100', 'focus:ring-0',
            'transition',
            'cursor-pointer', 'disabled:cursor-not-allowed',
            props.className as string,
        )}
    />;

export { Danger };
