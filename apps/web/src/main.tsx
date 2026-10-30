import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { HubClient } from './hub.js';
import './index.css';

const hub = new HubClient();

// For Web Push only (it caches nothing). Registration failing just means no push on this device.
if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => {});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App hub={hub} />
  </StrictMode>,
);
