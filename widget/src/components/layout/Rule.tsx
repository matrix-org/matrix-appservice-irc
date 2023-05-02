import React from 'react';
import classNames from 'classnames';

const Rule = (props: React.ComponentPropsWithoutRef<'hr'>) =>
    <hr
        {...props}
        className={classNames(
            'my-4',
            props.className,
        )}
    />;

export { Rule };
