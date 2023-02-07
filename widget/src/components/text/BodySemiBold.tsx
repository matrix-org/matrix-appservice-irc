import React from 'react';
import classNames from 'classnames';

const BodySemiBold = (props: React.ComponentPropsWithoutRef<'p'>) =>
    <h2 {...props} className={classNames('text-normal', 'font-semibold', props.className)}/>;

export { BodySemiBold };
