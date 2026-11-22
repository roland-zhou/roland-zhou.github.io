const CACHE_PREFIX = 'mymind-shell-';
const CACHE_NAME = `${CACHE_PREFIX}2`;
const HOME = self.registration.scope;
const INDEX = new URL('./index.html', HOME).href;

// Asset list: paths are stored without query strings so versioned URLs
// (script.js?v=7) still match the cached copy.
const ASSET_PATHS = [
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
];

// Normalize a URL to its cache key: drop query, keep origin+path.
function assetKey(url) {
    const copy = new URL(url);
    copy.search = '';
    copy.hash = '';
    return copy.href;
}

const ASSET_KEYS = new Set(
    ['index.html', ...ASSET_PATHS].map(path => new URL(path, HOME).href)
);

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        await cache.addAll(
            [HOME, ...ASSET_PATHS.map(path => new URL(path, HOME).href)]
                .map(url => new Request(url, { cache: 'reload' }))
        );
        await self.skipWaiting();
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
        const key = assetKey(url);
        if (key === HOME || key === INDEX) event.respondWith(networkFirst(request, HOME));
        return;
    }

    const key = assetKey(url.href);
    if (ASSET_KEYS.has(key)) {
        event.respondWith(networkFirst(request, key));
    }
});
