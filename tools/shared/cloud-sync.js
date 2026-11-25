/**
 * Shared Cloudflare Worker + D1 Cloud Sync Engine + Settings Modal.
 *
 * - Strictly opt-in: makes ZERO network requests when unconfigured.
 * - Same-origin config sharing across tools (localStorage key: roland.sync.cf.v1).
 * - Uses Cloudflare Worker + D1 SQLite with integer `version` optimistic locking
 *   (409 conflict auto-merge & retry) and ETag (`If-None-Match` -> 304) conditional GET.
 */

import { getPushClient, preparePush, revokeMyListPush, savePushClient, withPushLock } from './mylist-push.js';

export const SYNC_CONFIG_KEY = 'roland.sync.cf.v1';
const META_KEY_PREFIX = 'roland.sync.cf.meta.v1:';
const PAIR_V1 = 'CSYNC1';
const PAIR_V0 = 'CSYNC0';
const PAIR_SECRET = 'roland-cf-sync:pair:v1:rolandzhou.xyz';
const DEFAULT_AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const AUTO_SYNC_CHECK_MAX_MS = 30 * 1000;
const ERROR_RETRY_BASE_MS = 30 * 1000;

class ConflictError extends Error {
    constructor(message = '远端数据已被其他设备更新') {
        super(message);
        this.name = 'ConflictError';
    }
}

class SyncHttpError extends Error {
    constructor(status, message, authError = false) {
        super(message);
        this.name = 'SyncHttpError';
        this.status = status;
        this.authError = authError;
    }
}

/* ---------- Utilities ---------- */

export function normalizeEndpoint(raw) {
    if (typeof raw !== 'string') return '';
    let s = raw.trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) {
        const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(\/|$)/i.test(s);
        s = `${isLocal ? 'http' : 'https'}://${s}`;
    }
    let parsed;
    try {
        parsed = new URL(s);
    } catch {
        return '';
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    let pathname = parsed.pathname.replace(/\/+$/, '');
    // Strip accidental /api/... suffix if user pasted a full endpoint path
    pathname = pathname.replace(/\/api(?:\/.*)?$/i, '');
    return `${parsed.origin}${pathname}`;
}

export function formatEndpointHost(endpoint) {
    if (!endpoint) return '';
    try {
        const u = new URL(endpoint);
        const path = u.pathname.replace(/\/+$/, '');
        return path ? `${u.host}${path}` : u.host;
    } catch {
        return endpoint;
    }
}

function getLocalTimezone() {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
        return '';
    }
}

function toBase64Url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(str) {
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

export function formatSyncTime(ts) {
    if (!ts) return '尚未同步';
    const d = new Date(ts);
    const now = new Date();
    const diffSec = Math.floor((now - d) / 1000);
    if (diffSec < 15) return '刚刚';
    const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    if (d.toDateString() === now.toDateString()) return `今天 ${hhmm}`;
    return `${d.getMonth() + 1}/${d.getDate()} ${hhmm}`;
}

/* ---------- Config & Meta Storage ---------- */

export function readSyncConfig() {
    try {
        const raw = localStorage.getItem(SYNC_CONFIG_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        const endpoint = normalizeEndpoint(parsed?.endpoint);
        const token = typeof parsed?.token === 'string' ? parsed.token.trim() : '';
        if (!endpoint || !token) return null;
        return { endpoint, token };
    } catch {
        return null;
    }
}

export function writeSyncConfig(config) {
    try {
        if (!config) {
            localStorage.removeItem(SYNC_CONFIG_KEY);
            return;
        }
        localStorage.setItem(SYNC_CONFIG_KEY, JSON.stringify({
            endpoint: config.endpoint,
            token: config.token,
        }));
    } catch { /* storage unavailable */ }
}

function readMeta(appId) {
    try {
        const raw = localStorage.getItem(META_KEY_PREFIX + appId);
        if (!raw) return { version: null, etag: null, lastSyncAt: 0, dirty: false, extra: null };
        const p = JSON.parse(raw);
        const ver = Number(p?.version);
        return {
            version: Number.isInteger(ver) && ver > 0 ? ver : null,
            etag: typeof p?.etag === 'string' ? p.etag : null,
            lastSyncAt: Number(p?.lastSyncAt) || 0,
            dirty: Boolean(p?.dirty),
            extra: p?.extra ?? null,
        };
    } catch {
        return { version: null, etag: null, lastSyncAt: 0, dirty: false, extra: null };
    }
}

function writeMeta(appId, meta) {
    try {
        if (!meta) {
            localStorage.removeItem(META_KEY_PREFIX + appId);
            return;
        }
        localStorage.setItem(META_KEY_PREFIX + appId, JSON.stringify(meta));
    } catch { /* ignore */ }
}

/* ---------- Pairing Codec (AES-GCM via Web Crypto) ---------- */

let pairKeyPromise = null;
function getPairKey() {
    if (!globalThis.crypto?.subtle) return Promise.resolve(null);
    if (!pairKeyPromise) {
        pairKeyPromise = (async () => {
            const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(PAIR_SECRET));
            return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
        })();
    }
    return pairKeyPromise;
}

export async function encodePairingCode(config, extras = null) {
    const obj = {
        endpoint: config.endpoint,
        token: config.token,
    };
    if (extras && typeof extras === 'object' && !Array.isArray(extras) && Object.keys(extras).length > 0) {
        obj.extras = extras;
    }
    const payload = JSON.stringify(obj);
    const data = new TextEncoder().encode(payload);
    const key = await getPairKey();
    if (key) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
        const combined = new Uint8Array(iv.length + ct.length);
        combined.set(iv, 0);
        combined.set(ct, iv.length);
        return `${PAIR_V1}:${toBase64Url(combined)}`;
    }
    return `${PAIR_V0}:${toBase64Url(data)}`;
}

export async function decodePairingCode(input) {
    let text = String(input || '').trim();
    // Also accept a full pairing URL containing #sync=...
    const hashMatch = text.match(/#sync=([^\s&]+)/);
    if (hashMatch) {
        try { text = decodeURIComponent(hashMatch[1]); } catch { text = hashMatch[1]; }
    }
    const colon = text.indexOf(':');
    if (colon < 0) throw new Error('配对码格式不正确');
    const ver = text.slice(0, colon);
    const body = text.slice(colon + 1);
    let jsonStr;
    if (ver === PAIR_V1) {
        const key = await getPairKey();
        if (!key) throw new Error('当前非 HTTPS 环境无法解密配对码，请手动输入配置');
        const combined = fromBase64Url(body);
        if (combined.length < 13) throw new Error('配对码已损坏');
        const iv = combined.slice(0, 12);
        const ct = combined.slice(12);
        try {
            const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
            jsonStr = new TextDecoder().decode(pt);
        } catch {
            throw new Error('配对码解密失败，请确认复制完整');
        }
    } else if (ver === PAIR_V0) {
        jsonStr = new TextDecoder().decode(fromBase64Url(body));
    } else {
        throw new Error(`不支持的配对码版本 (${ver})`);
    }
    const obj = JSON.parse(jsonStr);
    const endpoint = normalizeEndpoint(obj?.endpoint);
    const token = typeof obj?.token === 'string' ? obj.token.trim() : '';
    if (!endpoint || !token) throw new Error('配对码中缺少服务地址或密钥');
    const extras = obj?.extras && typeof obj.extras === 'object' && !Array.isArray(obj.extras)
        ? obj.extras
        : null;
    return extras ? { endpoint, token, extras } : { endpoint, token };
}

/* ---------- Cloudflare Worker REST API ---------- */

async function workerFetch(url, token, options = {}) {
    const headers = {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
    };
    let res;
    try {
        res = await fetch(url, {
            ...options,
            headers,
            cache: 'no-store',
        });
    } catch {
        throw new SyncHttpError(0, '网络连接失败，请检查 Worker 地址、网络或 CORS 设置', false);
    }
    return res;
}

async function parseErrorMessage(res) {
    try {
        const data = await res.json();
        if (data?.message) return data.message;
    } catch { /* ignore */ }
    return `HTTP ${res.status}`;
}

export async function verifyEndpointAccess({ endpoint, token }) {
    const normalized = normalizeEndpoint(endpoint);
    if (!normalized) throw new Error('请输入有效的 Worker 地址（例如 https://roland-tools-sync.xxx.workers.dev）');
    const cleanToken = String(token || '').trim();
    if (!cleanToken) throw new Error('请输入访问密钥 (SYNC_TOKEN)');

    const res = await workerFetch(`${normalized}/api/health`, cleanToken, { method: 'GET' });
    if (res.status === 401 || res.status === 403) {
        throw new SyncHttpError(res.status, await parseErrorMessage(res), true);
    }
    if (res.status === 404) {
        throw new SyncHttpError(404, '该地址未提供 /api/health 接口，请确认已部署正确的 sync worker.js', false);
    }
    if (res.status === 503) {
        throw new SyncHttpError(503, await parseErrorMessage(res), false);
    }
    if (!res.ok) {
        throw new SyncHttpError(res.status, `验证失败：${await parseErrorMessage(res)}`, false);
    }

    const data = await res.json().catch(() => null);
    if (!data?.ok) {
        throw new SyncHttpError(500, '服务端返回格式异常，请确认已部署正确的 sync worker.js', false);
    }

    return {
        endpoint: normalized,
        token: cleanToken,
        apps: Array.isArray(data.apps) ? data.apps : [],
    };
}

async function fetchRemoteDoc(config, appId, { etag = null, bypassEtag = false } = {}) {
    const url = `${config.endpoint}/api/sync/${encodeURIComponent(appId)}`;
    const headers = {};
    if (etag && !bypassEtag) headers['If-None-Match'] = etag;

    const res = await workerFetch(url, config.token, { method: 'GET', headers });
    if (res.status === 304) return { notModified: true, notFound: false };
    if (res.status === 404) return { notModified: false, notFound: true };
    if (res.status === 401 || res.status === 403) {
        throw new SyncHttpError(res.status, await parseErrorMessage(res), true);
    }
    if (!res.ok) {
        throw new SyncHttpError(res.status, `拉取失败：${await parseErrorMessage(res)}`, false);
    }

    const body = await res.json();
    if (!body || typeof body.data !== 'object' || body.data === null) {
        throw new Error(`远端 ${appId} 数据格式无效，已中止以避免覆盖`);
    }

    const version = Number(body.version) || 1;
    return {
        notModified: false,
        notFound: false,
        version,
        etag: res.headers.get('etag') || `"v${version}"`,
        data: body.data,
    };
}

async function putRemoteDoc(config, appId, data, { expectedVersion = null } = {}) {
    const url = `${config.endpoint}/api/sync/${encodeURIComponent(appId)}`;
    const body = {
        data,
        expectedVersion: expectedVersion ?? null,
        timezone: getLocalTimezone(),
    };

    const res = await workerFetch(url, config.token, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (res.status === 409) throw new ConflictError('远端数据已被其他设备更新');
    if (res.status === 401 || res.status === 403) {
        throw new SyncHttpError(res.status, await parseErrorMessage(res), true);
    }
    if (!res.ok) {
        throw new SyncHttpError(res.status, `上传失败：${await parseErrorMessage(res)}`, false);
    }

    const payload = await res.json();
    const version = Number(payload?.version) || ((expectedVersion || 0) + 1);
    return {
        version,
        etag: res.headers.get('etag') || `"v${version}"`,
    };
}

/* ---------- Sync Engine + Modal ---------- */

export function createCloudSync({
    appId,
    appName,
    getLocalData,
    applyMergedData,
    mergeData,
    isBusy = () => false,
    onStatusChange = () => {},
    onToast = () => {},
    pushWorkerUrl = '',
    getPairingExtras = null,
    applyPairingExtras = null,
    debounceMs = 1500,
    resumeThrottleMs = 15000,
    autoSyncIntervalMs = DEFAULT_AUTO_SYNC_INTERVAL_MS,
}) {
    const autoSyncMs = Number.isFinite(autoSyncIntervalMs) && autoSyncIntervalMs > 0 ? autoSyncIntervalMs : 0;
    let config = readSyncConfig();
    let meta = readMeta(appId);
    let state = config ? (meta.dirty ? 'dirty' : 'synced') : 'unconfigured';
    let lastError = '';
    let lastErrorAuth = false;
    let pushTimer = null;
    let busyRetryTimer = null;
    let autoSyncTimer = null;
    let syncingPromise = null;
    let pendingResync = false;
    let pendingManual = false;
    let applyingRemote = false;
    let lastAttemptAt = 0;
    let consecutiveErrors = 0;
    let started = false;

    // Modal refs (created lazily on first open)
    let modal = null;
    let pendingPairConfig = null;
    let pushSetupFor = null;
    let pushSetup = null;
    let pushBusy = false;

    function getStatus() {
        return {
            state,
            configured: Boolean(config),
            endpoint: config?.endpoint || '',
            host: formatEndpointHost(config?.endpoint),
            appId,
            version: meta.version || 0,
            dirty: Boolean(meta.dirty),
            lastSyncAt: meta.lastSyncAt || 0,
            lastError,
            lastErrorAuth,
        };
    }

    function emitStatus() {
        const info = getStatus();
        onStatusChange(info);
        if (modal && !modal.backdrop.hidden) updateModalView();
    }

    function setState(next, err = '', authErr = false) {
        state = next;
        lastError = err;
        lastErrorAuth = authErr;
        emitStatus();
    }

    function saveMeta(patch) {
        meta = { ...meta, ...patch };
        writeMeta(appId, meta);
    }

    function isConfigured() {
        return Boolean(config);
    }

    function isDocumentHidden() {
        return typeof document !== 'undefined' && document.visibilityState === 'hidden';
    }

    function isNavigatorOffline() {
        return typeof navigator !== 'undefined' && navigator.onLine === false;
    }

    function clearAutoSyncTimer() {
        clearTimeout(autoSyncTimer);
        autoSyncTimer = null;
    }

    function clearTimers() {
        clearTimeout(pushTimer);
        pushTimer = null;
        clearTimeout(busyRetryTimer);
        busyRetryTimer = null;
        clearAutoSyncTimer();
    }

    function getNextAutoSyncDueAt() {
        if (state === 'error') {
            const backoff = Math.min(
                autoSyncMs,
                ERROR_RETRY_BASE_MS * (2 ** Math.min(Math.max(consecutiveErrors - 1, 0), 4))
            );
            return lastAttemptAt + backoff;
        }
        const lastAnchor = meta.lastSyncAt || lastAttemptAt;
        if (!lastAnchor) return 0;
        return lastAnchor + autoSyncMs;
    }

    function scheduleAutoSync() {
        clearAutoSyncTimer();
        if (!started || !config || !autoSyncMs) return;
        if (lastErrorAuth || isDocumentHidden()) return;
        if (syncingPromise || busyRetryTimer || pushTimer) return;

        const now = Date.now();
        const dueAt = getNextAutoSyncDueAt();
        const remaining = dueAt - now;
        const minImmediateDelay = Math.min(1000, autoSyncMs);
        const delay = remaining <= 0
            ? minImmediateDelay
            : Math.min(remaining, AUTO_SYNC_CHECK_MAX_MS);

        autoSyncTimer = setTimeout(() => {
            autoSyncTimer = null;
            runAutoSyncCheck();
        }, delay);
    }

    function runAutoSyncCheck() {
        if (!started || !config || !autoSyncMs) return;
        if (lastErrorAuth || isDocumentHidden()) return;
        if (syncingPromise || busyRetryTimer || pushTimer) return;
        if (isNavigatorOffline()) {
            // Keep a lightweight heartbeat while visible & offline in case the browser
            // does not fire an `online` event reliably after waking from sleep.
            autoSyncTimer = setTimeout(() => {
                autoSyncTimer = null;
                runAutoSyncCheck();
            }, Math.min(autoSyncMs, AUTO_SYNC_CHECK_MAX_MS));
            return;
        }
        if (Date.now() >= getNextAutoSyncDueAt()) {
            syncNow({ manual: false });
        } else {
            scheduleAutoSync();
        }
    }

    function markDirty() {
        if (applyingRemote) return;
        if (!config) return; // Opt-in: no state tracking or timers when unconfigured.
        saveMeta({ dirty: true });
        if (state !== 'syncing') setState('dirty', '', false);
        clearTimeout(pushTimer);
        pushTimer = setTimeout(() => {
            pushTimer = null;
            syncNow({ manual: false });
        }, debounceMs);
    }

    async function runSyncLoop(manual) {
        const currentConfig = config;
        if (!currentConfig) return { ok: false, skipped: true };

        let pulled = false;
        let pushed = false;
        let conflictCopies = 0;

        for (let attempt = 0; attempt < 3; attempt++) {
            const bypassEtag = manual || attempt > 0;
            const remote = await fetchRemoteDoc(currentConfig, appId, {
                etag: meta.etag,
                bypassEtag,
            });

            // Re-check config in case user disconnected mid-flight
            if (!config || config.endpoint !== currentConfig.endpoint) return { ok: false, skipped: true };

            if (remote.notModified) {
                if (!meta.dirty) {
                    saveMeta({ lastSyncAt: Date.now() });
                    return { ok: true, pulled: false, pushed: false, conflictCopies: 0 };
                }
                const localNow = getLocalData();
                try {
                    const putRes = await putRemoteDoc(currentConfig, appId, localNow, {
                        expectedVersion: meta.version,
                    });
                    pushed = true;
                    const mergedMeta = mergeData(localNow, localNow, { metaExtra: meta.extra });
                    saveMeta({
                        version: putRes.version,
                        etag: putRes.etag,
                        dirty: false,
                        lastSyncAt: Date.now(),
                        extra: mergedMeta.metaExtra ?? meta.extra,
                    });
                    return { ok: true, pulled, pushed, conflictCopies };
                } catch (err) {
                    if (err instanceof ConflictError && attempt < 2) {
                        saveMeta({ etag: null });
                        continue;
                    }
                    throw err;
                }
            }

            if (remote.notFound) {
                const localNow = getLocalData();
                try {
                    const putRes = await putRemoteDoc(currentConfig, appId, localNow, {
                        expectedVersion: null,
                    });
                    pushed = true;
                    const mergedMeta = mergeData(localNow, localNow, { metaExtra: meta.extra });
                    saveMeta({
                        version: putRes.version,
                        etag: putRes.etag,
                        dirty: false,
                        lastSyncAt: Date.now(),
                        extra: mergedMeta.metaExtra ?? meta.extra,
                    });
                    return { ok: true, pulled, pushed, conflictCopies };
                } catch (err) {
                    if (err instanceof ConflictError && attempt < 2) {
                        saveMeta({ etag: null });
                        continue;
                    }
                    throw err;
                }
            }

            // Remote document exists (200 OK)
            if (!manual && isBusy()) {
                clearTimeout(busyRetryTimer);
                busyRetryTimer = setTimeout(() => {
                    busyRetryTimer = null;
                    syncNow({ manual: false });
                }, 3000);
                return { ok: false, deferred: true };
            }

            const localBefore = getLocalData();
            const result = mergeData(localBefore, remote.data, { metaExtra: meta.extra });
            const { merged, localChanged, remoteChanged, metaExtra, conflictCount = 0 } = result;
            conflictCopies += conflictCount;

            if (localChanged) {
                applyingRemote = true;
                try {
                    applyMergedData(merged, { conflictCount });
                } finally {
                    applyingRemote = false;
                }
                pulled = true;
            }

            if (remoteChanged) {
                try {
                    const putRes = await putRemoteDoc(currentConfig, appId, merged, {
                        expectedVersion: remote.version,
                    });
                    pushed = true;
                    saveMeta({
                        version: putRes.version,
                        etag: putRes.etag,
                        dirty: false,
                        lastSyncAt: Date.now(),
                        extra: metaExtra ?? meta.extra,
                    });
                    return { ok: true, pulled, pushed, conflictCopies };
                } catch (err) {
                    if (err instanceof ConflictError && attempt < 2) {
                        saveMeta({ etag: null });
                        continue;
                    }
                    throw err;
                }
            } else {
                saveMeta({
                    version: remote.version,
                    etag: remote.etag,
                    dirty: false,
                    lastSyncAt: Date.now(),
                    extra: metaExtra ?? meta.extra,
                });
                return { ok: true, pulled, pushed, conflictCopies };
            }
        }

        throw new Error('同步冲突重试次数过多，请稍后重试');
    }

    async function syncNow({ manual = false, quiet = false } = {}) {
        if (!config) {
            if (manual) openSettings();
            return { ok: false, skipped: true };
        }

        clearTimeout(pushTimer);
        pushTimer = null;
        clearTimeout(busyRetryTimer);
        busyRetryTimer = null;
        clearAutoSyncTimer();

        if (!manual && isBusy()) {
            busyRetryTimer = setTimeout(() => {
                busyRetryTimer = null;
                syncNow({ manual: false });
            }, 3000);
            return { ok: false, deferred: true };
        }

        if (syncingPromise) {
            pendingResync = true;
            if (manual) pendingManual = true;
            return syncingPromise;
        }

        lastAttemptAt = Date.now();
        setState('syncing', '', false);

        syncingPromise = (async () => {
            try {
                const res = await runSyncLoop(manual);
                if (res.skipped) return res;
                if (res.deferred) {
                    setState(meta.dirty ? 'dirty' : 'synced', '', false);
                    return res;
                }
                consecutiveErrors = 0;
                setState(meta.dirty ? 'dirty' : 'synced', '', false);
                if (res.conflictCopies > 0) {
                    onToast(`同步完成：检测到 ${res.conflictCopies} 处并行编辑冲突，已另存为副本`, { duration: 4500 });
                } else if (manual && !quiet) {
                    if (res.pulled && res.pushed) onToast('同步完成（已合并云端更新）');
                    else if (res.pulled) onToast('已拉取最新云端数据');
                    else if (res.pushed) onToast('已同步到云端');
                    else onToast('已是最新');
                }
                return res;
            } catch (err) {
                const msg = err?.message || '同步失败';
                const authErr = Boolean(err?.authError);
                if (authErr) consecutiveErrors = 0;
                else consecutiveErrors += 1;
                setState('error', msg, authErr);
                if (manual && !quiet) {
                    onToast(`同步失败：${msg}`, {
                        actionLabel: authErr ? '设置' : '重试',
                        onAction: authErr ? () => openSettings() : () => syncNow({ manual: true }),
                        duration: 4200,
                    });
                }
                return { ok: false, error: msg };
            } finally {
                syncingPromise = null;
                if (pendingResync && config) {
                    const nextManual = pendingManual;
                    pendingResync = false;
                    pendingManual = false;
                    setTimeout(() => syncNow({ manual: nextManual }), 80);
                } else {
                    scheduleAutoSync();
                }
            }
        })();

        return syncingPromise;
    }

    function applyNewConfig(nextConfig) {
        const changedEndpoint = !config || config.endpoint !== nextConfig.endpoint;
        config = { endpoint: nextConfig.endpoint, token: nextConfig.token };
        writeSyncConfig(config);
        consecutiveErrors = 0;
        if (changedEndpoint) {
            saveMeta({ version: null, etag: null, lastSyncAt: 0, dirty: false, extra: null });
        }
        setState(meta.dirty ? 'dirty' : 'synced', '', false);
        scheduleAutoSync();
    }

    function disconnect() {
        clearTimers();
        pendingResync = false;
        pendingManual = false;
        consecutiveErrors = 0;
        config = null;
        writeSyncConfig(null);
        meta = { version: null, etag: null, lastSyncAt: 0, dirty: false, extra: null };
        writeMeta(appId, null);
        setState('unconfigured', '', false);
    }

    /* ---------- Lifecycle & Cross-Tab ---------- */

    function maybeResumeSync({ fromOnline = false } = {}) {
        if (!started || !config) return; // Strictly zero requests when unconfigured.
        if (isDocumentHidden()) return;
        if (fromOnline) consecutiveErrors = 0;
        if (syncingPromise) return;
        if (lastErrorAuth) return;
        if (!fromOnline && isNavigatorOffline()) {
            scheduleAutoSync();
            return;
        }
        const now = Date.now();
        const stale = autoSyncMs > 0 && (!meta.lastSyncAt || now - meta.lastSyncAt >= autoSyncMs);
        const cooledDown = now - lastAttemptAt >= resumeThrottleMs;
        const shouldSync = fromOnline
            ? (meta.dirty || state === 'error' || stale || cooledDown)
            : (meta.dirty || cooledDown);
        if (shouldSync) {
            syncNow({ manual: false });
        } else {
            scheduleAutoSync();
        }
    }

    const onVisibilityChange = () => {
        if (document.visibilityState === 'visible') {
            maybeResumeSync();
        } else {
            clearAutoSyncTimer();
        }
    };
    const onFocus = () => maybeResumeSync();
    const onPageShow = (event) => {
        if (event.persisted) maybeResumeSync();
    };
    const onOnline = () => maybeResumeSync({ fromOnline: true });
    const onStorage = (event) => {
        if (event.key === SYNC_CONFIG_KEY) {
            const prevEndpoint = config?.endpoint || '';
            config = readSyncConfig();
            consecutiveErrors = 0;
            if (!config) {
                clearTimers();
                meta = readMeta(appId);
                setState('unconfigured', '', false);
            } else {
                if (prevEndpoint !== config.endpoint) {
                    meta = readMeta(appId);
                }
                setState(meta.dirty ? 'dirty' : 'synced', '', false);
                if (!prevEndpoint) syncNow({ manual: false });
                else scheduleAutoSync();
            }
        } else if (event.key === META_KEY_PREFIX + appId) {
            meta = readMeta(appId);
            if (config && state !== 'syncing') {
                setState(meta.dirty ? 'dirty' : 'synced', '', false);
            }
            scheduleAutoSync();
        }
    };

    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVisibilityChange);
    }
    if (typeof window !== 'undefined') {
        window.addEventListener('focus', onFocus);
        window.addEventListener('pageshow', onPageShow);
        window.addEventListener('online', onOnline);
        window.addEventListener('storage', onStorage);
    }

    /* ---------- Shared Settings & Pairing Modal ---------- */

    function ensureModal() {
        if (modal) return modal;

        const backdrop = document.createElement('div');
        backdrop.className = 'csync-backdrop';
        backdrop.hidden = true;
        backdrop.innerHTML = `
            <div class="csync-dialog" role="dialog" aria-modal="true" aria-labelledby="csync-dialog-title">
                <header class="csync-header">
                    <span class="csync-title" id="csync-dialog-title">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 18h9.8a3.7 3.7 0 0 0 .5-7.35A5.3 5.3 0 0 0 7.4 9.2 4.2 4.2 0 0 0 7.5 18Z"/></svg>
                        <span>Cloudflare 云同步</span>
                    </span>
                    <button type="button" class="csync-close" data-csync-close aria-label="关闭">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/></svg>
                    </button>
                </header>
                <div class="csync-body">
                    <div class="csync-pair-confirm" data-csync-pair-confirm hidden>
                        <div class="csync-summary">
                            <div class="csync-summary-row">
                                <span class="csync-summary-label">待关联服务</span>
                                <span class="csync-summary-val"><code data-csync-pair-endpoint></code></span>
                            </div>
                        </div>
                        <p class="csync-note" style="margin-top: 10px;">
                            检测到来自其他设备的云同步配对链接。确认后将保存到当前浏览器，并与同域名下的 MyMind / MyList / ai问记 共用。
                        </p>
                        <div class="csync-actions" style="margin-top: 12px;">
                            <button type="button" class="csync-btn csync-btn-primary" data-csync-pair-accept>确认关联并同步</button>
                            <button type="button" class="csync-btn" data-csync-pair-cancel>取消</button>
                        </div>
                        <div class="csync-msg" data-csync-pair-msg></div>
                    </div>

                    <div data-csync-main>
                        <div class="csync-summary" data-csync-summary hidden>
                            <div class="csync-summary-row">
                                <span class="csync-summary-label">状态</span>
                                <span class="csync-status-badge">
                                    <span class="csync-dot" data-csync-dot></span>
                                    <span data-csync-state-text></span>
                                </span>
                            </div>
                            <div class="csync-summary-row">
                                <span class="csync-summary-label">Worker 服务</span>
                                <span class="csync-summary-val"><code data-csync-endpoint-display></code></span>
                            </div>
                            <div class="csync-summary-row">
                                <span class="csync-summary-label">数据空间</span>
                                <span class="csync-summary-val"><code data-csync-doc-display></code></span>
                            </div>
                            <div class="csync-summary-row">
                                <span class="csync-summary-label">上次同步</span>
                                <span class="csync-summary-val" data-csync-time-display></span>
                            </div>
                        </div>

                        <div class="csync-error-box" data-csync-err-box hidden></div>

                        <p class="csync-note" data-csync-intro>
                            可选功能：连接到你的 Cloudflare Worker + D1 轻量数据库，即可在多设备间低延迟自动同步。未配置时不发起任何网络请求；配置后与同域名下的 MyMind / MyList / ai问记 自动共享。
                        </p>

                        <form data-csync-form style="display:flex;flex-direction:column;gap:12px;">
                            <div class="csync-field">
                                <label for="csync-endpoint-input">
                                    <span>Worker 地址</span>
                                    <span class="csync-field-hint">Cloudflare Workers URL</span>
                                </label>
                                <input id="csync-endpoint-input" class="csync-input" type="url" autocomplete="off" spellcheck="false"
                                    placeholder="https://roland-tools-sync.xxx.workers.dev">
                            </div>

                            <div class="csync-field">
                                <label for="csync-token-input">
                                    <span>访问密钥 (SYNC_TOKEN)</span>
                                    <span class="csync-field-hint">仅存于本机浏览器</span>
                                </label>
                                <div class="csync-input-wrap">
                                    <input id="csync-token-input" class="csync-input" type="password" autocomplete="off" spellcheck="false"
                                        placeholder="填写你在 Worker Secret 中设置的密钥">
                                    <button type="button" class="csync-toggle-vis" data-csync-toggle-vis>显示</button>
                                </div>
                            </div>

                            <div class="csync-actions">
                                <button type="submit" class="csync-btn csync-btn-primary" data-csync-save>测试并连接</button>
                                <button type="button" class="csync-btn" data-csync-now hidden>立即同步</button>
                                <button type="button" class="csync-btn csync-btn-danger" data-csync-disconnect hidden>断开同步</button>
                            </div>
                            <div class="csync-msg" data-csync-msg></div>
                        </form>

                        ${pushWorkerUrl ? `
                        <div class="csync-section" data-csync-push hidden>
                            <div class="csync-section-title">到期通知</div>
                            <div class="csync-actions">
                                <button type="button" class="csync-btn" data-csync-push-toggle hidden></button>
                            </div>
                            <div class="csync-msg" data-csync-push-msg role="status"></div>
                        </div>` : ''}
                        <div class="csync-section" data-csync-pair-export hidden>
                            <div class="csync-section-title">多设备快速配对</div>
                            <p class="csync-note">
                                在新设备打开配对链接，或复制配对码粘贴导入（链接中的 #hash 不会发送到服务器）。
                            </p>
                            <div class="csync-actions">
                                <button type="button" class="csync-btn" data-csync-copy-link>复制配对链接</button>
                                <button type="button" class="csync-btn" data-csync-copy-code>复制配对码</button>
                            </div>
                            <div class="csync-msg" data-csync-export-msg></div>
                        </div>

                        <div class="csync-section" data-csync-pair-import>
                            <div class="csync-section-title">已有其他设备？直接导入配对码</div>
                            <textarea class="csync-textarea" data-csync-import-input placeholder="粘贴 CSYNC1:... 配对码或配对链接"></textarea>
                            <div class="csync-actions">
                                <button type="button" class="csync-btn" data-csync-import-apply>导入并连接</button>
                            </div>
                            <div class="csync-msg" data-csync-import-msg></div>
                        </div>

                        <details class="csync-details">
                            <summary>如何免费部署 Cloudflare Worker + D1 同步服务？</summary>
                            <ol>
                                <li>登录 <a href="https://dash.cloudflare.com/" target="_blank" rel="noopener">Cloudflare Dashboard</a> → <b>D1 SQL Database</b> → 新建数据库（如 <code>roland-tools-sync</code>）。</li>
                                <li>按仓库中 <code>tools/shared/cf-sync-worker/README.md</code> 部署 Worker（首次访问自动建表）。</li>
                                <li>在 Worker 设置中绑定该 D1 数据库，变量名填 <code>DB</code>；再添加一个 Secret 环境变量 <code>SYNC_TOKEN</code>（自定义随机密钥）。</li>
                                <li>将 Worker 的 <code>*.workers.dev</code> 地址与 <code>SYNC_TOKEN</code> 填回上方即可。</li>
                            </ol>
                        </details>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(backdrop);

        const q = (sel) => backdrop.querySelector(sel);
        modal = {
            backdrop,
            pairConfirmBox: q('[data-csync-pair-confirm]'),
            pairEndpoint: q('[data-csync-pair-endpoint]'),
            pairAcceptBtn: q('[data-csync-pair-accept]'),
            pairCancelBtn: q('[data-csync-pair-cancel]'),
            pairMsg: q('[data-csync-pair-msg]'),
            mainBox: q('[data-csync-main]'),
            summary: q('[data-csync-summary]'),
            dot: q('[data-csync-dot]'),
            stateText: q('[data-csync-state-text]'),
            endpointDisplay: q('[data-csync-endpoint-display]'),
            docDisplay: q('[data-csync-doc-display]'),
            timeDisplay: q('[data-csync-time-display]'),
            errBox: q('[data-csync-err-box]'),
            intro: q('[data-csync-intro]'),
            form: q('[data-csync-form]'),
            endpointInput: q('#csync-endpoint-input'),
            tokenInput: q('#csync-token-input'),
            toggleVisBtn: q('[data-csync-toggle-vis]'),
            saveBtn: q('[data-csync-save]'),
            nowBtn: q('[data-csync-now]'),
            disconnectBtn: q('[data-csync-disconnect]'),
            msg: q('[data-csync-msg]'),
            pushSection: q('[data-csync-push]'),
            pushToggle: q('[data-csync-push-toggle]'),
            pushMsg: q('[data-csync-push-msg]'),
            pairExport: q('[data-csync-pair-export]'),
            copyLinkBtn: q('[data-csync-copy-link]'),
            copyCodeBtn: q('[data-csync-copy-code]'),
            exportMsg: q('[data-csync-export-msg]'),
            pairImport: q('[data-csync-pair-import]'),
            importInput: q('[data-csync-import-input]'),
            importBtn: q('[data-csync-import-apply]'),
            importMsg: q('[data-csync-import-msg]'),
        };

        const setMsg = (el, text, cls = '') => {
            el.textContent = text || '';
            el.className = 'csync-msg' + (cls ? ' ' + cls : '');
        };

        const closeModal = () => {
            pendingPairConfig = null;
            backdrop.hidden = true;
            setMsg(modal.msg, '');
            setMsg(modal.exportMsg, '');
            setMsg(modal.importMsg, '');
            setMsg(modal.pairMsg, '');
        };

        q('[data-csync-close]').addEventListener('click', closeModal);
        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop) closeModal();
        });
        backdrop.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closeModal();
            }
        });

        modal.toggleVisBtn.addEventListener('click', () => {
            const showing = modal.tokenInput.type === 'text';
            modal.tokenInput.type = showing ? 'password' : 'text';
            modal.toggleVisBtn.textContent = showing ? '显示' : '隐藏';
        });

        async function connectAndSync(rawCfg, statusEl, btn) {
            const origText = btn.textContent;
            btn.disabled = true;
            btn.textContent = '验证中…';
            setMsg(statusEl, '正在验证 Worker 与 D1 连通性…', 'info');
            try {
                const verified = await verifyEndpointAccess(rawCfg);
                await withPushLock(async () => {
                    const previous = readSyncConfig();
                    if (previous && (previous.endpoint !== verified.endpoint || previous.token !== verified.token)) {
                        await revokeMyListPush(previous.endpoint === verified.endpoint ? verified : previous);
                    }
                    applyNewConfig(verified);
                });
                if (rawCfg?.extras && typeof applyPairingExtras === 'function') {
                    applyPairingExtras(rawCfg.extras);
                }
                setMsg(statusEl, '连接成功，正在首次同步…', 'ok');
                const syncRes = await syncNow({ manual: false });
                if (syncRes.ok) {
                    setMsg(statusEl, `已连接并同步（${formatEndpointHost(verified.endpoint)}）`, 'ok');
                    onToast('云同步已连接');
                    updateModalView();
                    return true;
                } else {
                    setMsg(statusEl, `已保存配置，但同步失败：${syncRes.error || '请稍后重试'}`, 'err');
                    updateModalView();
                    return false;
                }
            } catch (err) {
                setMsg(statusEl, err?.message || '验证失败', 'err');
                return false;
            } finally {
                btn.disabled = false;
                btn.textContent = origText;
            }
        }

        modal.form.addEventListener('submit', async (e) => {
            e.preventDefault();
            await connectAndSync({
                endpoint: modal.endpointInput.value,
                token: modal.tokenInput.value,
            }, modal.msg, modal.saveBtn);
        });

        modal.nowBtn.addEventListener('click', async () => {
            setMsg(modal.msg, '');
            await syncNow({ manual: true });
        });

        modal.disconnectBtn.addEventListener('click', async () => {
            if (!confirm('断开云同步？\n本地和云端数据会保留，此设备的到期通知将关闭。')) return;
            modal.disconnectBtn.disabled = true;
            try {
                await withPushLock(async () => {
                    await revokeMyListPush(readSyncConfig());
                    disconnect();
                });
                modal.endpointInput.value = '';
                modal.tokenInput.value = '';
                setMsg(modal.msg, '已断开云同步', 'info');
                onToast('已断开云同步');
                updateModalView();
            } catch (error) {
                setMsg(modal.msg, `关闭此设备的到期通知失败，请联网后重试。 ${error.message}`, 'err');
            } finally {
                modal.disconnectBtn.disabled = false;
            }
        });

        modal.pushToggle?.addEventListener('click', async () => {
            const current = config;
            const saved = getPushClient(current);
            const setup = pushSetup;
            if (!current || pushBusy || (!saved?.enabled && !setup)) return;
            pushBusy = true;
            modal.pushToggle.disabled = true;
            modal.pushMsg.textContent = saved?.enabled ? '正在关闭…' : '正在开启…';
            try {
                // Safari requires subscribe() to run directly in the tap handler.
                const subscription = saved?.enabled ? null : setup.subscription || await setup.registration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: setup.applicationServerKey,
                });
                await withPushLock(async () => {
                    const latest = readSyncConfig();
                    if (latest?.endpoint !== current.endpoint || latest.token !== current.token) {
                        throw new Error('同步配置已变更，请重新打开设置。');
                    }
                    if (saved?.enabled) {
                        await revokeMyListPush(current);
                    } else {
                        const result = await syncNow({ manual: true, quiet: true });
                        if (!result.ok) throw new Error(result.error || '请先完成一次 MyList 云同步。');
                        await savePushClient(current, subscription);
                    }
                });
                pushSetupFor = null;
            } catch (error) {
                modal.pushMsg.textContent = error.name === 'NotAllowedError'
                    ? '请在 iOS 设置中允许 MyList 通知，再重试。' : error.message;
            } finally {
                pushBusy = false;
                modal.pushToggle.disabled = false;
                updatePushView();
            }
        });

        async function copyText(str) {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(str);
                return;
            }
            const ta = document.createElement('textarea');
            ta.value = str;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
        }

        modal.copyLinkBtn.addEventListener('click', async () => {
            if (!config) return;
            try {
                const extras = typeof getPairingExtras === 'function' ? getPairingExtras() : null;
                const code = await encodePairingCode(config, extras);
                const url = `${location.origin}${location.pathname}#sync=${encodeURIComponent(code)}`;
                await copyText(url);
                setMsg(modal.exportMsg, '已复制配对链接！在新设备浏览器打开即可关联。', 'ok');
            } catch (err) {
                setMsg(modal.exportMsg, `复制失败：${err?.message || err}`, 'err');
            }
        });

        modal.copyCodeBtn.addEventListener('click', async () => {
            if (!config) return;
            try {
                const extras = typeof getPairingExtras === 'function' ? getPairingExtras() : null;
                const code = await encodePairingCode(config, extras);
                await copyText(code);
                setMsg(modal.exportMsg, '已复制配对码！可在另一设备的同步设置中导入。', 'ok');
            } catch (err) {
                setMsg(modal.exportMsg, `复制失败：${err?.message || err}`, 'err');
            }
        });

        modal.importBtn.addEventListener('click', async () => {
            const raw = modal.importInput.value.trim();
            if (!raw) {
                setMsg(modal.importMsg, '请先粘贴配对码或配对链接', 'err');
                return;
            }
            try {
                const decoded = await decodePairingCode(raw);
                const ok = await connectAndSync(decoded, modal.importMsg, modal.importBtn);
                if (ok) {
                    modal.importInput.value = '';
                    modal.endpointInput.value = decoded.endpoint;
                    modal.tokenInput.value = decoded.token;
                }
            } catch (err) {
                setMsg(modal.importMsg, err?.message || '配对码无效', 'err');
            }
        });

        modal.pairCancelBtn.addEventListener('click', closeModal);
        modal.pairAcceptBtn.addEventListener('click', async () => {
            if (!pendingPairConfig) return;
            const ok = await connectAndSync(pendingPairConfig, modal.pairMsg, modal.pairAcceptBtn);
            if (ok) {
                pendingPairConfig = null;
                closeModal();
            }
        });

        return modal;
    }

    const STATE_LABELS = {
        unconfigured: '未配置',
        synced: '已同步',
        dirty: '有未同步改动',
        syncing: '同步中…',
        error: '同步失败',
    };

    function updatePushView() {
        if (!modal?.pushSection) return;
        modal.pushSection.hidden = !config;
        if (!config) {
            pushSetupFor = null;
            pushSetup = null;
            return;
        }
        if (pushBusy) return;
        const enabled = getPushClient(config)?.enabled;
        modal.pushToggle.textContent = enabled ? '关闭此设备的通知' : '开启此设备的通知';
        modal.pushToggle.hidden = !enabled && !pushSetup;
        if (pushSetupFor === config) return;
        pushSetupFor = config;
        pushSetup = null;
        modal.pushToggle.hidden = !enabled;
        if (navigator.standalone !== true || !navigator.serviceWorker || !window.PushManager || !navigator.locks) {
            modal.pushMsg.textContent = '在 iOS 16.4 或更新版本中，将 MyList 添加到主屏幕并从图标打开。';
            return;
        }
        if (enabled) {
            modal.pushMsg.textContent = '已开启。带具体时间的未完成任务到期时会提醒。';
            return;
        }
        const current = config;
        modal.pushMsg.textContent = '正在检查通知支持…';
        preparePush(current, pushWorkerUrl).then((setup) => {
            if (config !== current || pushSetupFor !== current) return;
            pushSetup = setup;
            modal.pushToggle.hidden = false;
            modal.pushMsg.textContent = '带具体时间的未完成任务到期时会提醒。';
        }).catch((error) => {
            if (config === current && pushSetupFor === current) modal.pushMsg.textContent = error.message;
        });
    }

    function updateModalView() {
        if (!modal) return;
        const isPairMode = Boolean(pendingPairConfig);
        modal.pairConfirmBox.hidden = !isPairMode;
        modal.mainBox.hidden = isPairMode;
        if (isPairMode) {
            modal.pairEndpoint.textContent = formatEndpointHost(pendingPairConfig.endpoint);
            return;
        }

        const connected = Boolean(config);
        modal.summary.hidden = !connected;
        modal.intro.hidden = connected;
        modal.nowBtn.hidden = !connected;
        modal.nowBtn.disabled = state === 'syncing';
        modal.disconnectBtn.hidden = !connected;
        modal.pairExport.hidden = !connected;
        modal.pairImport.hidden = connected;
        modal.saveBtn.textContent = connected ? '更新配置' : '测试并连接';
        if (!modal.backdrop.hidden) updatePushView();

        if (connected) {
            modal.dot.dataset.state = state;
            modal.stateText.textContent = STATE_LABELS[state] || state;
            modal.endpointDisplay.textContent = formatEndpointHost(config.endpoint);
            modal.docDisplay.textContent = meta.version
                ? `${appId} · v${meta.version} (${appName})`
                : `${appId} (${appName})`;
            modal.timeDisplay.textContent = formatSyncTime(meta.lastSyncAt);
        }

        if (state === 'error' && lastError) {
            modal.errBox.textContent = `最近错误：${lastError}`;
            modal.errBox.hidden = false;
        } else {
            modal.errBox.hidden = true;
        }
    }

    function openSettings() {
        const m = ensureModal();
        pendingPairConfig = null;
        m.endpointInput.value = config?.endpoint || '';
        m.tokenInput.value = config?.token || '';
        m.tokenInput.type = 'password';
        m.toggleVisBtn.textContent = '显示';
        m.msg.textContent = '';
        m.exportMsg.textContent = '';
        m.importMsg.textContent = '';
        updateModalView();
        m.backdrop.hidden = false;
        pushSetupFor = null;
        updatePushView();
        requestAnimationFrame(() => {
            if (!config) m.endpointInput.focus();
        });
    }

    function isModalOpen() {
        return Boolean(modal && !modal.backdrop.hidden);
    }

    async function checkHashPairing() {
        if (typeof location === 'undefined') return false;
        const hash = location.hash || '';
        const match = hash.match(/^#sync=([^&]+)/);
        if (!match) return false;
        // Strip sensitive token hash from URL immediately so it does not linger in history.
        try {
            history.replaceState(null, '', location.pathname + location.search);
        } catch { /* ignore */ }
        try {
            const decoded = await decodePairingCode(decodeURIComponent(match[1]));
            const m = ensureModal();
            pendingPairConfig = decoded;
            m.pairMsg.textContent = '';
            updateModalView();
            m.backdrop.hidden = false;
            return true;
        } catch (err) {
            onToast(`配对链接无效：${err?.message || '格式错误'}`, { duration: 4000 });
            return false;
        }
    }

    function start() {
        started = true;
        emitStatus();
        checkHashPairing().then((hadPairing) => {
            if (!hadPairing && config) {
                // Only fetch on startup if already configured.
                syncNow({ manual: false });
            } else {
                scheduleAutoSync();
            }
        });
    }

    function destroy() {
        started = false;
        clearTimers();
        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', onVisibilityChange);
        }
        if (typeof window !== 'undefined') {
            window.removeEventListener('focus', onFocus);
            window.removeEventListener('pageshow', onPageShow);
            window.removeEventListener('online', onOnline);
            window.removeEventListener('storage', onStorage);
        }
    }

    return {
        start,
        destroy,
        isConfigured,
        getStatus,
        markDirty,
        syncNow,
        openSettings,
        isModalOpen,
    };
}
