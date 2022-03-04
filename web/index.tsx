import { h, render } from 'preact';
import 'preact/devtools';
import App from './App';
import "./styling.scss";
import "@fontsource/open-sans/400.css";
import "mini.css/dist/mini-default.min.css";
import "@fontsource/open-sans/files/open-sans-latin-400-normal.woff2";


const root = document.getElementsByTagName('main')[0];

if (root) {
  render(<App />, root);
}
