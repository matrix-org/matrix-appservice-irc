import React from 'react';
import classNames from 'classnames';

import * as Text from '../text';

const Input = (props: React.ComponentPropsWithoutRef<'input'> & { label?: string, comment?: string }) =>
    <label>
        { props.label && <Text.Caption className="text-grey-200">{ props.label }</Text.Caption>}
        <input
            {...props}
            className={classNames(
                'mt-1', 'block', 'w-full', 'rounded-md',
                'bg-white', 'text-black-900',
                'border', 'border-grey-50', 'focus:border-grey-100', 'focus:ring-0',
                'disabled:opacity-60',
                'transition',
                props.className,
            )}
        />
        { props.comment && <Text.Micro className="text-grey-200 mt-1">{ props.comment }</Text.Micro>}
    </label>;

export { Input };
