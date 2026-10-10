/* Sandesh service worker: shows push notifications when the app is closed */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch (err) { /* plain push */ }
  e.waitUntil(self.registration.showNotification(d.title || 'Sandesh', {
    body: d.body || 'New message',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: d.tag || 'sandesh',
    renotify: true,
    data: { peer: d.peer || '' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const peer = (e.notification.data && e.notification.data.peer) || '';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) {
        await c.focus();
        c.postMessage({ type: 'open-chat', peer });
        return;
      }
    }
    await self.clients.openWindow('/?chat=' + encodeURIComponent(peer));
  })());
});
