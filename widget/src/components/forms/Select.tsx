import React from 'react';
import classNames from 'classnames';

import * as Text from '../text';

const Select = (props: React.ComponentPropsWithoutRef<'select'> & { label?: string }) =>
    <label>
        { props.label && <Text.Caption className="text-grey-200">{ props.label }</Text.Caption>}
        <select
            {...props}
            className={classNames(
                'mt-1', 'block', 'w-full', 'rounded-md',
                'bg-white', 'text-black-900',
                'border-grey-50', 'focus:border-grey-100', 'focus:ring-0',
                'disabled:opacity-60',
                'transition',
                props.className,
            )}
        />
    </label>;

export { Select };
