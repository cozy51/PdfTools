/*
 * オフラインでも起動できるようにするService Worker。
 *
 * 配信ファイルを更新したときは CACHE_NAME を必ず変更する。変更しないと
 * 古いキャッシュが返り続け、利用者に新しい版が届かない。
 */

const CACHE_NAME = "pdf-tools-v1.7.0";

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./editor.css",
  "./editor.js",
  "./page-editor.js",
  "./pdf-core.js",
  "./app.webmanifest",
  "./vendor/pdf-lib.min.js",
  "./vendor/pdf.min.mjs",
  "./vendor/pdf.worker.min.mjs",
  "./icons/icon.svg",
  "./icons/icon-48.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith("pdf-tools-") && name !== CACHE_NAME)
            .map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  event.respondWith(respond(request));
});

async function respond(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response.ok && response.type === "basic") {
      void cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    // オフラインで未キャッシュのページを要求された場合はアプリ本体を返す。
    if (request.mode === "navigate") {
      const shell = await cache.match("./index.html");
      if (shell) {
        return shell;
      }
    }
    throw error;
  }
}
