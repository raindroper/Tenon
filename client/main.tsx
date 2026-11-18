import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { syncDesktopTitlebar } from './lib/desktop-titlebar';
import './styles.css';

syncDesktopTitlebar();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
);
