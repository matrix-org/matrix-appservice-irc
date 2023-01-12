import { render } from 'preact'
import { App } from './app'
import './index.scss'
import './assets/fonts/fonts.scss';

render(<App />, document.getElementById('app') as HTMLElement);
