// Т-банк — Service Worker
// Оффлайн-кэш + Web Push уведомления + мягкое автообновление

const CACHE = "wallet-sandbox-v6";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

const NETWORK_ONLY_PATHS = [
  "/messages",
  "/subscribe",
  "/subscriptions",
  "/vapid-public-key",
  "/health"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
      .then(async () => {
        const clientsList = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true
        });

        for (const client of clientsList) {
          client.postMessage({
            type: "SW_UPDATED",
            cache: CACHE
          });
        }
      })
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== "GET") return;

  // Для живых API-маршрутов никогда не используем кэш
  if (NETWORK_ONLY_PATHS.includes(url.pathname)) {
    event.respondWith(fetch(req));
    return;
  }

  // Для HTML всегда пробуем сеть первой, чтобы оболочка приложения обновлялась быстрее
  if (
    req.mode === "navigate" ||
    req.destination === "document" ||
    url.pathname === "/" ||
    url.pathname.endsWith(".html")
  ) {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          if (resp.ok && url.origin === self.location.origin) {
            const copy = resp.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return resp;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Для css/js/иконок — stale-while-revalidate:
  // сразу отдаём кэш, параллельно обновляем
  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((resp) => {
          if (resp.ok && url.origin === self.location.origin) {
            const copy = resp.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return resp;
        })
        .catch(() => cached);

      return cached || networkFetch;
    })
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("push", (event) => {
  let payload = {};

  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    try {
      payload = { body: event.data ? event.data.text() : "Новое сообщение" };
    } catch {
      payload = {};
    }
  }

  const title = payload.title || "Т-банк";
  const body = payload.body || "Новое сообщение";
  const url = payload.url || "/?route=chat";
  const author = payload.author || "";
  const messageId = payload.messageId || "";

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
      tag: messageId || "chat-message",
      renotify: true,
      data: {
        url,
        author,
        messageId,
      },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = event.notification?.data?.url || "/?route=chat";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        const url = new URL(client.url);

        if (url.origin === self.location.origin) {
          client.focus();
          return client.navigate(targetUrl);
        }
      }

      return clients.openWindow(targetUrl);
    })
  );
});