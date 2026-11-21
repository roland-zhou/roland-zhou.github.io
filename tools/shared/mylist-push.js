const CLIENT_KEY = 'roland.mylist.push.v1';

export function getPushClient(config) {
    try {
        const client = JSON.parse(localStorage.getItem(CLIENT_KEY));
        return config && client?.endpoint === config.endpoint ? client : null;
    } catch {
        return null;
    }
}

export function withPushLock(action) {
    return navigator.locks ? navigator.locks.request(CLIENT_KEY, action) : action();
}

async function pushFetch(config, suffix, options = {}) {
    const response = await fetch(`${config.endpoint}/api/push/mylist${suffix}`, {
        ...options,
        headers: { Authorization: `Bearer ${config.token}`, ...options.headers },
        cache: 'no-store',
    });
    if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.message || `推送设置请求失败（HTTP ${response.status}）`);
    }
    return response;
}

export async function preparePush(config, workerUrl) {
    const [response, registration] = await Promise.all([
        pushFetch(config, ''),
        navigator.serviceWorker.register(workerUrl),
    ]);
    const { publicKey } = await response.json();
    const encoded = publicKey.replace(/-/g, '+').replace(/_/g, '/');
    const applicationServerKey = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    const ready = registration.active ? registration : await navigator.serviceWorker.ready;
    let subscription = await ready.pushManager.getSubscription();
    const previousKey = subscription?.options?.applicationServerKey;
    if (previousKey && !new Uint8Array(previousKey).every((byte, i) => byte === applicationServerKey[i])) {
        await subscription.unsubscribe();
        subscription = null;
    }
    return { registration: ready, applicationServerKey, subscription };
}

export async function savePushClient(config, subscription) {
    const client = getPushClient(config) || { id: crypto.randomUUID(), endpoint: config.endpoint, enabled: false };
    // Store the ID before sending so a failed response can still be revoked.
    localStorage.setItem(CLIENT_KEY, JSON.stringify(client));
    await pushFetch(config, `/${client.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription),
    });
    localStorage.setItem(CLIENT_KEY, JSON.stringify({ ...client, enabled: true }));
}

export async function revokeMyListPush(config) {
    const client = getPushClient(config);
    if (!client) return;
    await pushFetch(config, `/${client.id}`, { method: 'DELETE' });
    localStorage.removeItem(CLIENT_KEY);
}
