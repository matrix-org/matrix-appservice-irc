import { render } from 'preact';

import { App } from './app';
import './styles/index.css';

render(<App />, document.getElementById('app') as HTMLElement);
