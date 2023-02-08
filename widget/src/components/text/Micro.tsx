import React from 'react';
import classNames from 'classnames';

const Micro = (props: React.ComponentPropsWithoutRef<'h5'>) =>
    <h5 {...props} className={classNames('text-xs', 'font-normal', props.className as string)}/>;

export { Micro };
