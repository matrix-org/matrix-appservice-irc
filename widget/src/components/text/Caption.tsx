import React from 'preact';
import classNames from 'classnames';

const Caption = (props: React.ComponentProps<'h4'>) =>
    <h4 {...props} className={classNames('text-sm', 'font-normal', props.className as string)}/>;

export { Caption };
