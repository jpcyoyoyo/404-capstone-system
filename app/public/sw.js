/*
 * Service worker for Web Push notifications from the cloud server (controller/greenhouse/push.py).
 * Registered only when someone turns notifications on (src/components/push.ts). It does nothing
 * else: no caching, no offline copy of the app, so a new app version is never held back by it.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = { body: event.data ? event.data.text() : '' };
  }
  const options = {
    body: d.body || '',
    tag: d.tag || 'greenhouse',
    renotify: d.renotify !== false,
    icon: '/icons/icon-192.png',
    // A critical alert stays on screen until it is tapped or swiped away.
    requireInteraction: d.severity === 'critical',
    timestamp: d.ts ? Date.parse(d.ts) : Date.now(),
    data: { url: d.url || '/tabs/alerts' },
  };
  event.waitUntil(self.registration.showNotification(d.title || 'Greenhouse alert', options));
});

// Tapping the notification opens the page it is about: an open app window is brought forward and
// told where to go (src/components/PushNavigator.tsx); otherwise a new window opens there.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const path = (event.notification.data && event.notification.data.url) || '/tabs/alerts';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find(w => new URL(w.url).origin === self.location.origin);
    if (win) {
      await win.focus();
      win.postMessage({ type: 'sg-open', path });
      return;
    }
    await self.clients.openWindow(new URL(path, self.location.origin).href);
  })());
});
