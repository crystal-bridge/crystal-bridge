// Crystal Bridge service worker: Web Push only. It caches nothing, so Discreet Kingdoms leave nothing behind.
// The hub renders each push for this device ({ title, body, tag, node, session }); an open tab already notifies
// through the page, so a push is shown only when no window of the app is visible and focused (macOS Chrome calls a
// window behind another app visible). The same tag collapses repeats.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let data;
      try {
        data = event.data ? event.data.json() : null;
      } catch {
        data = null;
      }
      if (!data || typeof data.title !== 'string') return;
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (windows.some((client) => client.visibilityState === 'visible' && client.focused)) return;
      await self.registration.showNotification(data.title, {
        body: data.body,
        tag: data.tag,
        icon: '/icon-192.png',
        data: { node: data.node, session: data.session },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { node, session } = event.notification.data ?? {};
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows[0];
      if (open) {
        await open.focus();
        if (node && session) open.postMessage({ kind: 'open', node, session });
        return;
      }
      const query = node && session ? `?${new URLSearchParams({ node, session })}` : '';
      await self.clients.openWindow(`/${query}`);
    })(),
  );
});
