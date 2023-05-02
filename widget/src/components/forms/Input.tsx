import React from 'react';
import classNames from 'classnames';

import * as Text from '../text';

const Input = ({
    label,
    comment,
    ...props
}: React.ComponentPropsWithoutRef<'input'> & { label?: string, comment?: string }) =>
    <label>
        { label && <Text.Micro className="text-grey-200">{ label }</Text.Micro>}
        <input
            {...props}
            className={classNames(
                'mt-1', 'block', 'w-full', 'px-3', 'py-2', 'rounded-md',
                'bg-white', 'text-black-900',
                'border', 'border-grey-50', 'focus:border-grey-100', 'focus:ring-0',
                'disabled:opacity-60',
                'transition',
                props.className,
            )}
        />
        { comment && <Text.Micro className="text-grey-200 mt-1">{ comment }</Text.Micro>}
    </label>;

export { Input };
