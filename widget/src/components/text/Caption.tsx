import React from 'react';
import classNames from 'classnames';

const Caption = (props: React.ComponentPropsWithoutRef<'h4'>) =>
    <h4 {...props} className={classNames('text-sm', 'font-normal', props.className as string)}/>;

export { Caption };
