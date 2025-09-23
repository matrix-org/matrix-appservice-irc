import React from 'react';
import classNames from 'classnames';

const Title = (props: React.ComponentPropsWithoutRef<'h2'>) =>
    <h2 {...props} className={classNames('text-2xl', 'font-semibold', props.className)}/>;

export { Title };
