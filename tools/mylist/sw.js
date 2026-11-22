// MyList service worker: offline app shell + push notifications.
// A single worker serves both purposes so registration scope stays ./.

const CACHE_PREFIX = 'mylist-shell-';
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
    '../shared/cloud-sync.css',
    '../shared/cloud-sync.js',
    '../shared/mylist-push.js',
];

// Normalize a URL to its cache key: drop query for assets, keep origin+path.
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
        // Precache the shell. The HTML page is requested fresh (no-cache is not
        // needed, but use reload so the very first install gets current bytes).
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
        await Promise.all(
            keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
                .map(key => caches.delete(key))
        );
        await self.clients.claim();
    })());
});

// Network first, then cache fallback. Revalidates fresh copies when online so
// deployments update even without bumping the worker version.
async function networkFirst(request, key) {
    const response = await fetch(request, { cache: 'no-cache' }).catch(() => null);
    if (response?.ok && !response.redirected) {
        try {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(key, response.clone());
        } catch (error) {
            console.warn('MyList could not cache', key, error);
        }
    }
    if (response && response.status < 500) return response;

    const cached = await caches.match(key, { cacheName: CACHE_NAME });
    return cached ?? response ?? Response.error();
}

self.addEventListener('fetch', event => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (request.mode === 'navigate') {
        // Only the app itself; this worker is scoped to ./ so sibling pages are
        // never shadowed. Normalize to HOME and serve cached shell when offline.
        const key = assetKey(url);
        if (key === HOME || key === INDEX) {
            event.respondWith(networkFirst(request, HOME));
        }
        return;
    }

    const key = assetKey(url.href);
    if (ASSET_KEYS.has(key)) {
        event.respondWith(networkFirst(request, key));
    }
});

// Push notifications (unchanged behavior, required for optional cloud sync).
self.addEventListener('push', event => {
    const { title, body, tag } = event.data.json();
    event.waitUntil(self.registration.showNotification(title, { body, tag }));
});

self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil((async () => {
        const scope = self.registration.scope;
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const app = windows.find(client => client.url.startsWith(scope));
        if (app) await app.focus();
        else await self.clients.openWindow(scope);
    })());
});
