import React from 'react';
import classNames from 'classnames';

const SubtitleSemiBold = (props: React.ComponentPropsWithoutRef<'h2'>) =>
    <h2 {...props} className={classNames('text-lg', 'font-semibold', props.className)}/>;

export { SubtitleSemiBold };
