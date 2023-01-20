import React from 'preact';
import classNames from 'classnames';

const Title = (props: React.ComponentProps<'h2'>) =>
    <h2 {...props} className={classNames('text-2xl', 'font-semibold', props.className as string)}/>;

export { Title };
