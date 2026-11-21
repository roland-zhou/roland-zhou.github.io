/**
 * Shared GitHub Private Repository Cloud Sync Engine + Settings Modal.
 *
 * - Strictly opt-in: makes ZERO network requests when unconfigured.
 * - Same-origin config sharing across tools (localStorage key: roland.sync.github.v1).
 * - Uses GitHub Contents API with file `sha` optimistic locking (409 conflict auto-merge & retry),
 *   ETag conditional requests, and >1MB Git Blobs fallback.
 */

export const SYNC_CONFIG_KEY = 'roland.sync.github.v1';
const META_KEY_PREFIX = 'roland.sync.meta.v1:';
const PAIR_V1 = 'GSYNC1';
const PAIR_V0 = 'GSYNC0';
const PAIR_SECRET = 'roland-github-sync:pair:v1:rolandzhou.xyz';
const API_BASE = 'https://api.github.com';
const API_HEADERS = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
};

class ConflictError extends Error {
    constructor(message = '远端文件已被其他设备更新') {
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

export function normalizeRepo(raw) {
    if (typeof raw !== 'string') return '';
    let s = raw.trim();
    s = s.replace(/^https?:\/\/github\.com\//i, '');
    s = s.replace(/^github\.com\//i, '');
    s = s.replace(/^\/+|\/+$/g, '');
    s = s.replace(/\.git$/i, '');
    const parts = s.split('/').filter(Boolean);
    if (parts.length < 2) return '';
    const owner = parts[0];
    const repo = parts[1];
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return '';
    return `${owner}/${repo}`;
}

function encodeBase64Utf8(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
}

function decodeBase64Utf8(b64) {
    const clean = String(b64 || '').replace(/\s+/g, '');
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
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

function formatCommitTime(d = new Date()) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function encodeFilePath(path) {
    return String(path).split('/').map(encodeURIComponent).join('/');
}

/* ---------- Config & Meta Storage ---------- */

export function readSyncConfig() {
    try {
        const raw = localStorage.getItem(SYNC_CONFIG_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        const repo = normalizeRepo(parsed?.repo);
        const token = typeof parsed?.token === 'string' ? parsed.token.trim() : '';
        const branch = typeof parsed?.branch === 'string' && parsed.branch.trim() ? parsed.branch.trim() : 'main';
        if (!repo || !token) return null;
        return { repo, branch, token };
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
            repo: config.repo,
            branch: config.branch || 'main',
            token: config.token,
        }));
    } catch { /* storage unavailable */ }
}

function readMeta(filePath) {
    try {
        const raw = localStorage.getItem(META_KEY_PREFIX + filePath);
        if (!raw) return { sha: null, etag: null, lastSyncAt: 0, dirty: false, extra: null };
        const p = JSON.parse(raw);
        return {
            sha: typeof p?.sha === 'string' ? p.sha : null,
            etag: typeof p?.etag === 'string' ? p.etag : null,
            lastSyncAt: Number(p?.lastSyncAt) || 0,
            dirty: Boolean(p?.dirty),
            extra: p?.extra ?? null,
        };
    } catch {
        return { sha: null, etag: null, lastSyncAt: 0, dirty: false, extra: null };
    }
}

function writeMeta(filePath, meta) {
    try {
        if (!meta) {
            localStorage.removeItem(META_KEY_PREFIX + filePath);
            return;
        }
        localStorage.setItem(META_KEY_PREFIX + filePath, JSON.stringify(meta));
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

export async function encodePairingCode(config) {
    const payload = JSON.stringify({
        repo: config.repo,
        branch: config.branch || 'main',
        token: config.token,
    });
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
    const repo = normalizeRepo(obj?.repo);
    const token = typeof obj?.token === 'string' ? obj.token.trim() : '';
    const branch = typeof obj?.branch === 'string' && obj.branch.trim() ? obj.branch.trim() : 'main';
    if (!repo || !token) throw new Error('配对码中缺少仓库或 Token 信息');
    return { repo, branch, token };
}

/* ---------- GitHub REST API ---------- */

async function githubFetch(url, token, options = {}) {
    const headers = {
        ...API_HEADERS,
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
        throw new SyncHttpError(0, '网络连接失败，请检查网络或代理', false);
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

export async function verifyRepoAccess({ repo, token, branch }) {
    const normalized = normalizeRepo(repo);
    if (!normalized) throw new Error('仓库格式应为 owner/repo（例如 roland-zhou/my-tools-data）');
    const cleanToken = String(token || '').trim();
    if (!cleanToken) throw new Error('请输入 GitHub Token');

    const res = await githubFetch(`${API_BASE}/repos/${normalized}`, cleanToken, { method: 'GET' });
    if (res.status === 401) throw new SyncHttpError(401, 'Token 无效或已过期', true);
    if (res.status === 403) {
        const detail = await parseErrorMessage(res);
        throw new SyncHttpError(403, `访问被拒绝（${detail}）`, true);
    }
    if (res.status === 404) {
        throw new SyncHttpError(404, '找不到该仓库，或 Token 没有此仓库的访问权限', true);
    }
    if (!res.ok) {
        throw new SyncHttpError(res.status, `验证失败：${await parseErrorMessage(res)}`, false);
    }

    const data = await res.json();
    if (data.permissions && data.permissions.push === false) {
        throw new SyncHttpError(403, 'Token 缺少 Contents 写权限，请在 GitHub 中开启 Read and write', true);
    }

    const resolvedBranch = (branch && branch.trim()) || data.default_branch || 'main';
    return {
        repo: normalized,
        branch: resolvedBranch,
        token: cleanToken,
        isPrivate: Boolean(data.private),
    };
}

async function fetchRemoteFile(config, filePath, { etag = null, bypassEtag = false } = {}) {
    const encodedPath = encodeFilePath(filePath);
    const url = `${API_BASE}/repos/${config.repo}/contents/${encodedPath}?ref=${encodeURIComponent(config.branch)}`;
    const headers = {};
    if (etag && !bypassEtag) headers['If-None-Match'] = etag;

    const res = await githubFetch(url, config.token, { method: 'GET', headers });
    if (res.status === 304) return { notModified: true, notFound: false };
    if (res.status === 404) return { notModified: false, notFound: true };
    if (res.status === 401) throw new SyncHttpError(401, 'Token 无效或已过期', true);
    if (res.status === 403) throw new SyncHttpError(403, `无权读取仓库（${await parseErrorMessage(res)}）`, true);
    if (!res.ok) throw new SyncHttpError(res.status, `拉取失败：${await parseErrorMessage(res)}`, false);

    const data = await res.json();
    let text;
    if (typeof data.content === 'string' && data.content.length > 0 && data.encoding === 'base64') {
        text = decodeBase64Utf8(data.content);
    } else if (data.sha) {
        // Fallback for files larger than 1MB where Contents API omits inline content.
        const blobRes = await githubFetch(`${API_BASE}/repos/${config.repo}/git/blobs/${data.sha}`, config.token, { method: 'GET' });
        if (!blobRes.ok) throw new SyncHttpError(blobRes.status, `读取大文件失败：${await parseErrorMessage(blobRes)}`, false);
        const blob = await blobRes.json();
        text = decodeBase64Utf8(blob.content || '');
    } else {
        text = '';
    }

    return {
        notModified: false,
        notFound: false,
        sha: data.sha || null,
        etag: res.headers.get('etag') || null,
        text,
    };
}

async function putRemoteFile(config, filePath, text, { sha = null, message }) {
    const encodedPath = encodeFilePath(filePath);
    const url = `${API_BASE}/repos/${config.repo}/contents/${encodedPath}`;
    const body = {
        message,
        content: encodeBase64Utf8(text),
        branch: config.branch,
    };
    if (sha) body.sha = sha;

    const res = await githubFetch(url, config.token, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (res.status === 409) throw new ConflictError('远端文件已变更');
    if (res.status === 422) {
        const msg = await parseErrorMessage(res);
        // Missing or stale sha on concurrent creation/update returns 422 on GitHub API.
        if (/sha/i.test(msg)) throw new ConflictError(msg);
        throw new SyncHttpError(422, `写入失败：${msg}`, false);
    }
    if (res.status === 401) throw new SyncHttpError(401, 'Token 无效或已过期', true);
    if (res.status === 403) throw new SyncHttpError(403, `没有写入权限（${await parseErrorMessage(res)}）`, true);
    if (res.status === 404) throw new SyncHttpError(404, '仓库或分支不存在，或 Token 缺少写权限', true);
    if (!res.ok) throw new SyncHttpError(res.status, `上传失败：${await parseErrorMessage(res)}`, false);

    const data = await res.json();
    return {
        sha: data?.content?.sha || null,
        etag: null,
    };
}

/* ---------- Sync Engine + Modal ---------- */

export function createGitHubSync({
    appId,
    appName,
    filePath,
    getLocalData,
    applyMergedData,
    mergeData,
    isBusy = () => false,
    onStatusChange = () => {},
    onToast = () => {},
    debounceMs = 3000,
    resumeThrottleMs = 15000,
}) {
    let config = readSyncConfig();
    let meta = readMeta(filePath);
    let state = config ? (meta.dirty ? 'dirty' : 'synced') : 'unconfigured';
    let lastError = '';
    let lastErrorAuth = false;
    let pushTimer = null;
    let busyRetryTimer = null;
    let syncingPromise = null;
    let pendingResync = false;
    let pendingManual = false;
    let applyingRemote = false;
    let lastAttemptAt = 0;

    // Modal refs (created lazily on first open)
    let modal = null;
    let pendingPairConfig = null;

    function getStatus() {
        return {
            state,
            configured: Boolean(config),
            repo: config?.repo || '',
            branch: config?.branch || 'main',
            filePath,
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
        writeMeta(filePath, meta);
    }

    function isConfigured() {
        return Boolean(config);
    }

    function clearTimers() {
        clearTimeout(pushTimer);
        pushTimer = null;
        clearTimeout(busyRetryTimer);
        busyRetryTimer = null;
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
            const remote = await fetchRemoteFile(currentConfig, filePath, {
                etag: meta.etag,
                bypassEtag,
            });

            // Re-check config in case user disconnected mid-flight
            if (!config || config.repo !== currentConfig.repo) return { ok: false, skipped: true };

            if (remote.notModified) {
                if (!meta.dirty) {
                    saveMeta({ lastSyncAt: Date.now() });
                    return { ok: true, pulled: false, pushed: false, conflictCopies: 0 };
                }
                const localNow = getLocalData();
                const text = JSON.stringify(localNow, null, 2) + '\n';
                try {
                    const putRes = await putRemoteFile(currentConfig, filePath, text, {
                        sha: meta.sha,
                        message: `sync(${appId}): ${formatCommitTime()}`,
                    });
                    pushed = true;
                    const mergedMeta = mergeData(localNow, localNow, { metaExtra: meta.extra });
                    saveMeta({
                        sha: putRes.sha,
                        etag: null,
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
                const text = JSON.stringify(localNow, null, 2) + '\n';
                try {
                    const putRes = await putRemoteFile(currentConfig, filePath, text, {
                        sha: null,
                        message: `sync(${appId}): init ${formatCommitTime()}`,
                    });
                    pushed = true;
                    const mergedMeta = mergeData(localNow, localNow, { metaExtra: meta.extra });
                    saveMeta({
                        sha: putRes.sha,
                        etag: null,
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

            // Remote file exists (200 OK)
            let remoteData;
            try {
                remoteData = JSON.parse(remote.text);
            } catch {
                throw new Error(`远端文件 ${filePath} 不是有效的 JSON，已中止以避免覆盖`);
            }

            // Don't interrupt active typing/dragging during automatic background pulls
            if (!manual && isBusy()) {
                clearTimeout(busyRetryTimer);
                busyRetryTimer = setTimeout(() => {
                    busyRetryTimer = null;
                    syncNow({ manual: false });
                }, 3000);
                return { ok: false, deferred: true };
            }

            const localBefore = getLocalData();
            const result = mergeData(localBefore, remoteData, { metaExtra: meta.extra });
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
                const text = JSON.stringify(merged, null, 2) + '\n';
                try {
                    const putRes = await putRemoteFile(currentConfig, filePath, text, {
                        sha: remote.sha,
                        message: `sync(${appId}): ${formatCommitTime()}`,
                    });
                    pushed = true;
                    saveMeta({
                        sha: putRes.sha,
                        etag: null,
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
                    sha: remote.sha,
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

    async function syncNow({ manual = false } = {}) {
        if (!config) {
            if (manual) openSettings();
            return { ok: false, skipped: true };
        }

        clearTimeout(pushTimer);
        pushTimer = null;
        clearTimeout(busyRetryTimer);
        busyRetryTimer = null;

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
                setState(meta.dirty ? 'dirty' : 'synced', '', false);
                if (res.conflictCopies > 0) {
                    onToast(`同步完成：检测到 ${res.conflictCopies} 处并行编辑冲突，已另存为副本`, { duration: 4500 });
                } else if (manual) {
                    if (res.pulled && res.pushed) onToast('同步完成（已合并云端更新）');
                    else if (res.pulled) onToast('已拉取最新云端数据');
                    else if (res.pushed) onToast('已同步到云端');
                    else onToast('已是最新');
                }
                return res;
            } catch (err) {
                const msg = err?.message || '同步失败';
                const authErr = Boolean(err?.authError);
                setState('error', msg, authErr);
                if (manual) {
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
                }
            }
        })();

        return syncingPromise;
    }

    function applyNewConfig(nextConfig) {
        const changedRepo = !config || config.repo !== nextConfig.repo || config.branch !== nextConfig.branch;
        config = nextConfig;
        writeSyncConfig(config);
        if (changedRepo) {
            saveMeta({ sha: null, etag: null, lastSyncAt: 0, dirty: false, extra: null });
        }
        setState(meta.dirty ? 'dirty' : 'synced', '', false);
    }

    function disconnect() {
        clearTimers();
        pendingResync = false;
        pendingManual = false;
        config = null;
        writeSyncConfig(null);
        meta = { sha: null, etag: null, lastSyncAt: 0, dirty: false, extra: null };
        writeMeta(filePath, null);
        setState('unconfigured', '', false);
    }

    /* ---------- Lifecycle & Cross-Tab ---------- */

    function maybeResumeSync() {
        if (!config) return; // Strictly zero requests when unconfigured.
        if (document.visibilityState === 'hidden') return;
        if (meta.dirty || Date.now() - lastAttemptAt >= resumeThrottleMs) {
            syncNow({ manual: false });
        }
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') maybeResumeSync();
    });
    window.addEventListener('online', () => maybeResumeSync());

    window.addEventListener('storage', (event) => {
        if (event.key === SYNC_CONFIG_KEY) {
            const prevRepo = config?.repo || '';
            config = readSyncConfig();
            if (!config) {
                clearTimers();
                meta = readMeta(filePath);
                setState('unconfigured', '', false);
            } else {
                if (prevRepo !== config.repo) {
                    meta = readMeta(filePath);
                }
                setState(meta.dirty ? 'dirty' : 'synced', '', false);
                if (!prevRepo) syncNow({ manual: false });
            }
        } else if (event.key === META_KEY_PREFIX + filePath) {
            meta = readMeta(filePath);
            if (config && state !== 'syncing') {
                setState(meta.dirty ? 'dirty' : 'synced', '', false);
            }
        }
    });

    /* ---------- Shared Settings & Pairing Modal ---------- */

    function ensureModal() {
        if (modal) return modal;

        const backdrop = document.createElement('div');
        backdrop.className = 'gsync-backdrop';
        backdrop.hidden = true;
        backdrop.innerHTML = `
            <div class="gsync-dialog" role="dialog" aria-modal="true" aria-labelledby="gsync-dialog-title">
                <header class="gsync-header">
                    <span class="gsync-title" id="gsync-dialog-title">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 18h9.8a3.7 3.7 0 0 0 .5-7.35A5.3 5.3 0 0 0 7.4 9.2 4.2 4.2 0 0 0 7.5 18Z"/></svg>
                        <span>GitHub 云同步</span>
                    </span>
                    <button type="button" class="gsync-close" data-gsync-close aria-label="关闭">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/></svg>
                    </button>
                </header>
                <div class="gsync-body">
                    <div class="gsync-pair-confirm" data-gsync-pair-confirm hidden>
                        <div class="gsync-summary">
                            <div class="gsync-summary-row">
                                <span class="gsync-summary-label">待关联仓库</span>
                                <span class="gsync-summary-val" data-gsync-pair-repo></span>
                            </div>
                            <div class="gsync-summary-row">
                                <span class="gsync-summary-label">分支</span>
                                <span class="gsync-summary-val" data-gsync-pair-branch></span>
                            </div>
                        </div>
                        <p class="gsync-note" style="margin-top: 10px;">
                            检测到来自其他设备的云同步配对链接。确认后将保存到当前浏览器，并与同域名下的 MyMind / MyList 共用。
                        </p>
                        <div class="gsync-actions" style="margin-top: 12px;">
                            <button type="button" class="gsync-btn gsync-btn-primary" data-gsync-pair-accept>确认关联并同步</button>
                            <button type="button" class="gsync-btn" data-gsync-pair-cancel>取消</button>
                        </div>
                        <div class="gsync-msg" data-gsync-pair-msg></div>
                    </div>

                    <div data-gsync-main>
                        <div class="gsync-summary" data-gsync-summary hidden>
                            <div class="gsync-summary-row">
                                <span class="gsync-summary-label">状态</span>
                                <span class="gsync-status-badge">
                                    <span class="gsync-dot" data-gsync-dot></span>
                                    <span data-gsync-state-text></span>
                                </span>
                            </div>
                            <div class="gsync-summary-row">
                                <span class="gsync-summary-label">仓库</span>
                                <span class="gsync-summary-val"><code data-gsync-repo-display></code></span>
                            </div>
                            <div class="gsync-summary-row">
                                <span class="gsync-summary-label">同步文件</span>
                                <span class="gsync-summary-val"><code data-gsync-file-display></code></span>
                            </div>
                            <div class="gsync-summary-row">
                                <span class="gsync-summary-label">上次同步</span>
                                <span class="gsync-summary-val" data-gsync-time-display></span>
                            </div>
                        </div>

                        <div class="gsync-error-box" data-gsync-err-box hidden></div>

                        <p class="gsync-note" data-gsync-intro>
                            可选功能：关联你的 GitHub 私有仓库即可在多设备间自动同步数据。未配置时不会发起任何网络请求；配置后与同域名下的 MyMind / MyList 自动共享。
                        </p>

                        <form data-gsync-form style="display:flex;flex-direction:column;gap:12px;">
                            <div class="gsync-field">
                                <label for="gsync-repo-input">
                                    <span>私有仓库</span>
                                    <span class="gsync-field-hint">格式 owner/repo</span>
                                </label>
                                <input id="gsync-repo-input" class="gsync-input" type="text" autocomplete="off" spellcheck="false"
                                    placeholder="例如 roland-zhou/my-tools-data">
                            </div>

                            <div class="gsync-field">
                                <label for="gsync-token-input">
                                    <span>Fine-grained PAT</span>
                                    <span class="gsync-field-hint">仅存于本机浏览器</span>
                                </label>
                                <div class="gsync-input-wrap">
                                    <input id="gsync-token-input" class="gsync-input" type="password" autocomplete="off" spellcheck="false"
                                        placeholder="github_pat_...">
                                    <button type="button" class="gsync-toggle-vis" data-gsync-toggle-vis>显示</button>
                                </div>
                            </div>

                            <div class="gsync-actions">
                                <button type="submit" class="gsync-btn gsync-btn-primary" data-gsync-save>测试并连接</button>
                                <button type="button" class="gsync-btn" data-gsync-now hidden>立即同步</button>
                                <button type="button" class="gsync-btn gsync-btn-danger" data-gsync-disconnect hidden>断开同步</button>
                            </div>
                            <div class="gsync-msg" data-gsync-msg></div>
                        </form>

                        <div class="gsync-section" data-gsync-pair-export hidden>
                            <div class="gsync-section-title">多设备快速配对</div>
                            <p class="gsync-note">
                                在新设备打开配对链接，或复制配对码粘贴导入（链接中的 #hash 不会发送到服务器）。
                            </p>
                            <div class="gsync-actions">
                                <button type="button" class="gsync-btn" data-gsync-copy-link>复制配对链接</button>
                                <button type="button" class="gsync-btn" data-gsync-copy-code>复制配对码</button>
                            </div>
                            <div class="gsync-msg" data-gsync-export-msg></div>
                        </div>

                        <div class="gsync-section" data-gsync-pair-import>
                            <div class="gsync-section-title">已有其他设备？直接导入配对码</div>
                            <textarea class="gsync-textarea" data-gsync-import-input placeholder="粘贴 GSYNC1:... 配对码或配对链接"></textarea>
                            <div class="gsync-actions">
                                <button type="button" class="gsync-btn" data-gsync-import-apply>导入并连接</button>
                            </div>
                            <div class="gsync-msg" data-gsync-import-msg></div>
                        </div>

                        <details class="gsync-details">
                            <summary>如何创建仅限单仓库的 GitHub Token？</summary>
                            <ol>
                                <li>新建一个 <b>Private</b> 私有仓库（如 <code>my-tools-data</code>），建议勾选初始化 README。</li>
                                <li>打开 <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub Fine-grained tokens</a> 创建新 Token。</li>
                                <li>Repository access 选 <b>Only select repositories</b> 并只勾该私有库；Repository permissions 中将 <b>Contents</b> 设为 <b>Read and write</b>，生成后粘回上方即可。</li>
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
            pairConfirmBox: q('[data-gsync-pair-confirm]'),
            pairRepo: q('[data-gsync-pair-repo]'),
            pairBranch: q('[data-gsync-pair-branch]'),
            pairAcceptBtn: q('[data-gsync-pair-accept]'),
            pairCancelBtn: q('[data-gsync-pair-cancel]'),
            pairMsg: q('[data-gsync-pair-msg]'),
            mainBox: q('[data-gsync-main]'),
            summary: q('[data-gsync-summary]'),
            dot: q('[data-gsync-dot]'),
            stateText: q('[data-gsync-state-text]'),
            repoDisplay: q('[data-gsync-repo-display]'),
            fileDisplay: q('[data-gsync-file-display]'),
            timeDisplay: q('[data-gsync-time-display]'),
            errBox: q('[data-gsync-err-box]'),
            intro: q('[data-gsync-intro]'),
            form: q('[data-gsync-form]'),
            repoInput: q('#gsync-repo-input'),
            tokenInput: q('#gsync-token-input'),
            toggleVisBtn: q('[data-gsync-toggle-vis]'),
            saveBtn: q('[data-gsync-save]'),
            nowBtn: q('[data-gsync-now]'),
            disconnectBtn: q('[data-gsync-disconnect]'),
            msg: q('[data-gsync-msg]'),
            pairExport: q('[data-gsync-pair-export]'),
            copyLinkBtn: q('[data-gsync-copy-link]'),
            copyCodeBtn: q('[data-gsync-copy-code]'),
            exportMsg: q('[data-gsync-export-msg]'),
            pairImport: q('[data-gsync-pair-import]'),
            importInput: q('[data-gsync-import-input]'),
            importBtn: q('[data-gsync-import-apply]'),
            importMsg: q('[data-gsync-import-msg]'),
        };

        const setMsg = (el, text, cls = '') => {
            el.textContent = text || '';
            el.className = 'gsync-msg' + (cls ? ' ' + cls : '');
        };

        const closeModal = () => {
            pendingPairConfig = null;
            backdrop.hidden = true;
            setMsg(modal.msg, '');
            setMsg(modal.exportMsg, '');
            setMsg(modal.importMsg, '');
            setMsg(modal.pairMsg, '');
        };

        q('[data-gsync-close]').addEventListener('click', closeModal);
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
            setMsg(statusEl, '正在验证仓库与 Token 权限…', 'info');
            try {
                const verified = await verifyRepoAccess(rawCfg);
                applyNewConfig(verified);
                setMsg(statusEl, '连接成功，正在首次同步…', 'ok');
                const syncRes = await syncNow({ manual: false });
                if (syncRes.ok) {
                    setMsg(statusEl, `已连接并同步（${verified.repo} · ${verified.branch}）`, 'ok');
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
                repo: modal.repoInput.value,
                token: modal.tokenInput.value,
                branch: config?.repo === normalizeRepo(modal.repoInput.value) ? config?.branch : '',
            }, modal.msg, modal.saveBtn);
        });

        modal.nowBtn.addEventListener('click', async () => {
            setMsg(modal.msg, '');
            await syncNow({ manual: true });
        });

        modal.disconnectBtn.addEventListener('click', () => {
            if (!confirm('断开云同步？\n本地数据和 GitHub 仓库里的文件都会保留，仅清除本浏览器的同步配置。')) return;
            disconnect();
            modal.repoInput.value = '';
            modal.tokenInput.value = '';
            setMsg(modal.msg, '已断开云同步', 'info');
            onToast('已断开云同步');
            updateModalView();
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
                const code = await encodePairingCode(config);
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
                const code = await encodePairingCode(config);
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
                    modal.repoInput.value = decoded.repo;
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

    function updateModalView() {
        if (!modal) return;
        const isPairMode = Boolean(pendingPairConfig);
        modal.pairConfirmBox.hidden = !isPairMode;
        modal.mainBox.hidden = isPairMode;
        if (isPairMode) {
            modal.pairRepo.textContent = pendingPairConfig.repo;
            modal.pairBranch.textContent = pendingPairConfig.branch || 'main';
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

        if (connected) {
            modal.dot.dataset.state = state;
            modal.stateText.textContent = STATE_LABELS[state] || state;
            modal.repoDisplay.textContent = `${config.repo} (${config.branch})`;
            modal.fileDisplay.textContent = `${filePath} (${appName})`;
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
        m.repoInput.value = config?.repo || '';
        m.tokenInput.value = config?.token || '';
        m.tokenInput.type = 'password';
        m.toggleVisBtn.textContent = '显示';
        m.msg.textContent = '';
        m.exportMsg.textContent = '';
        m.importMsg.textContent = '';
        updateModalView();
        m.backdrop.hidden = false;
        requestAnimationFrame(() => {
            if (!config) m.repoInput.focus();
        });
    }

    function isModalOpen() {
        return Boolean(modal && !modal.backdrop.hidden);
    }

    async function checkHashPairing() {
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
        emitStatus();
        checkHashPairing().then((hadPairing) => {
            if (!hadPairing && config) {
                // Only fetch on startup if already configured.
                syncNow({ manual: false });
            }
        });
    }

    return {
        start,
        isConfigured,
        getStatus,
        markDirty,
        syncNow,
        openSettings,
        isModalOpen,
    };
}
