import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { LoginGate } from './components/LoginGate.js';
import { HubClient } from './hub.js';
import './index.css';

// Made on first use, so the live socket only opens once LoginGate has let the app in: before that it would be refused,
// and the user would log in to a "Lost the connection" banner while it backed off.
let hub: HubClient | undefined;
function Connected() {
  hub ??= new HubClient();
  return <App hub={hub} />;
}

// For Web Push only (it caches nothing). Registration failing just means no push on this device.
if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => {});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LoginGate>
      <Connected />
    </LoginGate>
  </StrictMode>,
);
