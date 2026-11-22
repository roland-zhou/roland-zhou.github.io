const CACHE_PREFIX = 'mymind-shell-';
const CACHE_NAME = `${CACHE_PREFIX}1`;
const HOME = self.registration.scope;
const INDEX = new URL('./index.html', HOME).href;
const ASSETS = new Set([
    './style.css',
    './app.js',
    './model.js',
    './favicon.svg',
    './apple-touch-icon.png',
    './manifest.webmanifest',
    './icon-192.png',
    './icon-512.png',
    '../shared/cloud-sync.css',
    '../shared/cloud-sync.js',
    '../shared/mylist-push.js',
].map(path => new URL(path, HOME).href));

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        await cache.addAll([HOME, ...ASSETS].map(url => new Request(url, { cache: 'reload' })));
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map(key => caches.delete(key)));
        await self.clients.claim();
    })());
});

async function networkFirst(request, cacheKey) {
    // Revalidate static files so deployments pick up changes even when this worker is unchanged.
    const response = await fetch(request, { cache: 'no-cache' }).catch(() => null);
    if (response?.ok && !response.redirected) {
        try {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(cacheKey, response.clone());
        } catch (error) {
            console.warn('MyMind could not cache', cacheKey, error);
        }
    }
    if (response && response.status < 500) return response;

    const cached = await caches.match(cacheKey, { cacheName: CACHE_NAME });
    return cached ?? response ?? Response.error();
}

self.addEventListener('fetch', event => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (request.mode === 'navigate') {
        url.search = '';
        if (url.href === HOME || url.href === INDEX) event.respondWith(networkFirst(request, HOME));
    } else if (ASSETS.has(url.href)) {
        event.respondWith(networkFirst(request, url.href));
    }
});
