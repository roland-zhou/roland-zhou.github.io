/**
 * Cloudflare Worker + D1 (SQLite) Cloud Sync Backend for MyList & MyMind.
 *
 * Zero dependencies — deploy with Wrangler or paste its bundle into the Cloudflare Dashboard.
 *
 * Required Cloudflare bindings / secrets:
 *   - D1 Database binding named: DB
 *   - Secret environment variable: SYNC_TOKEN
 * Optional environment variable:
 *   - ALLOWED_ORIGIN (comma-separated origins, e.g. "https://rolandzhou.xyz"; defaults to "*")
 *
 * API:
 *   GET  /                    -> Public liveness check
 *   GET  /api/health          -> Auth + D1 check, returns synced app summaries
 *   GET  /api/sync/:appId     -> Fetch app JSON doc (supports If-None-Match -> 304)
 *   PUT  /api/sync/:appId     -> Atomic optimistic-locked write (returns 409 on version mismatch)
 */

import { sendMyListReminders } from './mylist-reminders.js';
import { loadVapid, syncKey, validPushEndpoint, validSubscriptionKeys } from './web-push.js';

const APP_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PUSH_CLIENT_RE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MAX_PAYLOAD_BYTES = 1800 * 1024; // Stay safely under D1's 2 MB per-row limit

const INIT_STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS sync_docs (
        app_id     TEXT PRIMARY KEY,
        payload    TEXT NOT NULL,
        version    INTEGER NOT NULL DEFAULT 1,
        timezone   TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS mylist_push_clients (
        client_id  TEXT PRIMARY KEY,
        endpoint   TEXT UNIQUE,
        p256dh     TEXT NOT NULL DEFAULT '',
        auth       TEXT NOT NULL DEFAULT '',
        sync_key   TEXT NOT NULL DEFAULT '',
        enabled_at INTEGER NOT NULL DEFAULT 0
    )`,
    'CREATE INDEX IF NOT EXISTS idx_mylist_push_sync_key ON mylist_push_clients(sync_key)',
    `CREATE TABLE IF NOT EXISTS reminder_logs (
        reminder_key TEXT PRIMARY KEY,
        app_id       TEXT NOT NULL,
        item_id      TEXT NOT NULL,
        sent_at      INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_reminder_logs_sent_at ON reminder_logs(sent_at)`,
];

const schemaReadyByDb = new WeakMap();

function ensureSchema(db) {
    let promise = schemaReadyByDb.get(db);
    if (!promise) {
        promise = db
            .batch(INIT_STATEMENTS.map((sql) => db.prepare(sql)))
            .catch((err) => {
                schemaReadyByDb.delete(db);
                throw err;
            });
        schemaReadyByDb.set(db, promise);
    }
    return promise;
}

/* ---------- CORS & Response Helpers ---------- */

function resolveCorsOrigin(request, env) {
    const configured = String(env?.ALLOWED_ORIGIN || '').trim();
    if (!configured || configured === '*') return '*';
    const allowed = configured.split(',').map((s) => s.trim()).filter(Boolean);
    const reqOrigin = request.headers.get('Origin') || '';
    if (allowed.includes(reqOrigin)) return reqOrigin;
    return allowed[0] || '*';
}

function buildCorsHeaders(request, env) {
    const origin = resolveCorsOrigin(request, env);
    const headers = {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-None-Match, If-Match',
        'Access-Control-Expose-Headers': 'ETag',
        'Access-Control-Max-Age': '86400',
    };
    if (origin !== '*') headers['Vary'] = 'Origin';
    return headers;
}

function corsResponse(request, env, body, init = {}) {
    const headers = new Headers(init.headers || {});
    for (const [k, v] of Object.entries(buildCorsHeaders(request, env))) {
        headers.set(k, v);
    }
    return new Response(body, { ...init, headers });
}

function jsonResponse(request, env, data, status = 200, extraHeaders = {}) {
    return corsResponse(request, env, JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            ...extraHeaders,
        },
    });
}

/* ---------- Auth (Constant-Time SHA-256 Comparison) ---------- */

async function timingSafeEquals(a, b) {
    const enc = new TextEncoder();
    const [ha, hb] = await Promise.all([
        crypto.subtle.digest('SHA-256', enc.encode(String(a))),
        crypto.subtle.digest('SHA-256', enc.encode(String(b))),
    ]);
    const ba = new Uint8Array(ha);
    const bb = new Uint8Array(hb);
    let diff = 0;
    for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
    return diff === 0;
}

async function authorize(request, env) {
    const expected = typeof env?.SYNC_TOKEN === 'string' ? env.SYNC_TOKEN.trim() : '';
    if (!expected) {
        return { ok: false, status: 503, message: '服务端未配置 SYNC_TOKEN 环境变量' };
    }
    const auth = request.headers.get('Authorization') || '';
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match) {
        return { ok: false, status: 401, message: '缺少访问密钥（Authorization: Bearer）' };
    }
    const provided = match[1].trim();
    if (!provided || !(await timingSafeEquals(provided, expected))) {
        return { ok: false, status: 401, message: '访问密钥无效' };
    }
    return { ok: true };
}

/* ---------- ETag / Version Helpers ---------- */

function versionToEtag(version) {
    return `"v${version}"`;
}

function etagMatches(headerValue, etag) {
    if (!headerValue) return false;
    const target = etag.replace(/^W\//i, '').trim();
    return headerValue.split(',').some((part) => {
        const clean = part.trim().replace(/^W\//i, '');
        return clean === '*' || clean === target;
    });
}

function parseVersionFromIfMatch(headerValue) {
    if (!headerValue) return undefined;
    const m = headerValue.trim().match(/^(?:W\/)?"?v(\d+)"?$/i);
    return m ? Number(m[1]) : undefined;
}

/* ---------- Route Handlers ---------- */

async function handleHealth(request, env) {
    await ensureSchema(env.DB);
    const res = await env.DB.prepare(
        'SELECT app_id, version, timezone, updated_at FROM sync_docs ORDER BY app_id ASC'
    ).all();
    const apps = (res.results || []).map((r) => ({
        appId: r.app_id,
        version: Number(r.version) || 0,
        timezone: r.timezone || '',
        updatedAt: Number(r.updated_at) || 0,
    }));
    return jsonResponse(request, env, {
        ok: true,
        service: 'cf-d1-sync',
        apps,
        serverTime: Date.now(),
    });
}

async function handleGetDoc(request, env, appId) {
    await ensureSchema(env.DB);
    const row = await env.DB.prepare(
        'SELECT payload, version, timezone, updated_at FROM sync_docs WHERE app_id = ?'
    )
        .bind(appId)
        .first();

    if (!row) {
        return jsonResponse(request, env, { ok: false, message: '云端尚无此应用数据' }, 404);
    }

    const version = Number(row.version) || 1;
    const etag = versionToEtag(version);

    if (etagMatches(request.headers.get('If-None-Match'), etag)) {
        return corsResponse(request, env, null, {
            status: 304,
            headers: {
                ETag: etag,
                'Cache-Control': 'no-store',
            },
        });
    }

    let data;
    try {
        data = JSON.parse(row.payload);
    } catch {
        return jsonResponse(request, env, { ok: false, message: '云端存储的数据格式损坏' }, 500);
    }

    return jsonResponse(
        request,
        env,
        {
            ok: true,
            appId,
            version,
            timezone: row.timezone || '',
            updatedAt: Number(row.updated_at) || 0,
            data,
        },
        200,
        { ETag: etag }
    );
}

async function handlePutDoc(request, env, appId) {
    await ensureSchema(env.DB);

    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse(request, env, { ok: false, message: '请求体不是有效的 JSON' }, 400);
    }

    if (!body || typeof body !== 'object' || body.data === null || typeof body.data !== 'object') {
        return jsonResponse(request, env, { ok: false, message: '缺少有效的 data 对象' }, 400);
    }

    const payload = JSON.stringify(body.data);
    const byteLength = new TextEncoder().encode(payload).byteLength;
    if (byteLength > MAX_PAYLOAD_BYTES) {
        return jsonResponse(
            request,
            env,
            { ok: false, message: `同步数据过大（${Math.round(byteLength / 1024)} KB），超过 D1 单行限制` },
            413
        );
    }

    let expectedVersion = body.expectedVersion;
    if (expectedVersion === undefined) {
        const fromHeader = parseVersionFromIfMatch(request.headers.get('If-Match'));
        expectedVersion = fromHeader !== undefined ? fromHeader : null;
    }

    if (expectedVersion !== null && (!Number.isInteger(expectedVersion) || expectedVersion < 0)) {
        return jsonResponse(request, env, { ok: false, message: 'expectedVersion 必须为非负整数或 null' }, 400);
    }

    const timezone = typeof body.timezone === 'string' ? body.timezone.trim().slice(0, 64) : '';
    const now = Date.now();

    let nextVersion;
    let changed = 0;

    if (!expectedVersion) {
        const result = await env.DB.prepare(
            `INSERT OR IGNORE INTO sync_docs (app_id, payload, version, timezone, updated_at)
             VALUES (?, ?, 1, ?, ?)`
        )
            .bind(appId, payload, timezone, now)
            .run();
        changed = Number(result?.meta?.changes || 0);
        nextVersion = 1;
    } else {
        const result = await env.DB.prepare(
            `UPDATE sync_docs
             SET payload = ?, version = version + 1, timezone = CASE WHEN ? != '' THEN ? ELSE timezone END, updated_at = ?
             WHERE app_id = ? AND version = ?`
        )
            .bind(payload, timezone, timezone, now, appId, expectedVersion)
            .run();
        changed = Number(result?.meta?.changes || 0);
        nextVersion = expectedVersion + 1;
    }

    if (changed === 0) {
        const current = await env.DB.prepare('SELECT version FROM sync_docs WHERE app_id = ?')
            .bind(appId)
            .first();
        return jsonResponse(
            request,
            env,
            {
                ok: false,
                error: 'conflict',
                message: '远端数据已被其他设备更新',
                currentVersion: current ? Number(current.version) : 0,
            },
            409
        );
    }

    const etag = versionToEtag(nextVersion);
    return jsonResponse(
        request,
        env,
        {
            ok: true,
            appId,
            version: nextVersion,
            updatedAt: now,
        },
        200,
        { ETag: etag }
    );
}

async function handlePushClient(request, env, clientId) {
    await ensureSchema(env.DB);
    if (request.method === 'DELETE') {
        // Keep a tombstone so a delayed or retried PUT cannot reactivate this client ID.
        await env.DB.prepare(
            `INSERT INTO mylist_push_clients (client_id) VALUES (?)
             ON CONFLICT(client_id) DO UPDATE SET endpoint = NULL, p256dh = '', auth = '', sync_key = '', enabled_at = 0`
        ).bind(clientId).run();
        return corsResponse(request, env, null, { status: 204 });
    }

    if (request.method !== 'PUT') {
        return jsonResponse(request, env, { ok: false, message: 'Method Not Allowed' }, 405);
    }
    const body = await request.json().catch(() => null);
    if (!validPushEndpoint(body?.endpoint) || !validSubscriptionKeys(body?.keys?.p256dh, body?.keys?.auth)) {
        return jsonResponse(request, env, { ok: false, message: '无效的 Apple 推送订阅' }, 400);
    }
    const vapid = await loadVapid(env);
    if (!vapid) return jsonResponse(request, env, { ok: false, message: 'Worker 尚未配置 Web Push' }, 503);
    const key = await syncKey(env.SYNC_TOKEN);
    const result = await env.DB.prepare(
        `INSERT INTO mylist_push_clients (client_id, endpoint, p256dh, auth, sync_key, enabled_at)
         SELECT ?, ?, ?, ?, ?, ? FROM sync_docs WHERE app_id = 'mylist'
         ON CONFLICT(client_id) DO UPDATE SET endpoint = excluded.endpoint,
             p256dh = excluded.p256dh, auth = excluded.auth, sync_key = excluded.sync_key
         WHERE mylist_push_clients.endpoint IS NOT NULL OR mylist_push_clients.enabled_at > 0`
    ).bind(clientId, body.endpoint, body.keys.p256dh, body.keys.auth, key, Date.now()).run();
    if (!result.meta.changes) {
        return jsonResponse(request, env, { ok: false, message: '请先同步 MyList，或关闭提醒后重新开启' }, 409);
    }
    return corsResponse(request, env, null, { status: 204 });
}

/* ---------- Worker Entrypoint ---------- */

export default {
    async fetch(request, env) {
        try {
            if (request.method === 'OPTIONS') {
                return corsResponse(request, env, null, { status: 204 });
            }

            const url = new URL(request.url);
            const path = url.pathname.replace(/\/+$/, '') || '/';

            if (path === '/' && request.method === 'GET') {
                return jsonResponse(request, env, { ok: true, service: 'cf-d1-sync' });
            }

            if (!path.startsWith('/api/')) {
                return jsonResponse(request, env, { ok: false, message: 'Not Found' }, 404);
            }

            const auth = await authorize(request, env);
            if (!auth.ok) {
                return jsonResponse(request, env, { ok: false, message: auth.message }, auth.status);
            }

            if (!env?.DB) {
                return jsonResponse(request, env, { ok: false, message: '服务端未绑定 D1 数据库（变量名需为 DB）' }, 503);
            }

            if (path === '/api/health' && request.method === 'GET') {
                return await handleHealth(request, env);
            }

            if (path === '/api/push/mylist' && request.method === 'GET') {
                const vapid = await loadVapid(env);
                if (!vapid) return jsonResponse(request, env, { ok: false, message: 'Worker 尚未配置 Web Push' }, 503);
                return jsonResponse(request, env, { publicKey: vapid.publicKey });
            }
            if (path.startsWith('/api/push/mylist/')) {
                const clientId = path.slice('/api/push/mylist/'.length);
                if (!PUSH_CLIENT_RE.test(clientId)) {
                    return jsonResponse(request, env, { ok: false, message: '无效的客户端 ID' }, 400);
                }
                return await handlePushClient(request, env, clientId);
            }

            const syncMatch = path.match(/^\/api\/sync\/([^/]+)$/);
            if (syncMatch) {
                const appId = decodeURIComponent(syncMatch[1]);
                if (!APP_ID_RE.test(appId)) {
                    return jsonResponse(request, env, { ok: false, message: '无效的 appId' }, 400);
                }
                if (request.method === 'GET') {
                    return await handleGetDoc(request, env, appId);
                }
                if (request.method === 'PUT') {
                    return await handlePutDoc(request, env, appId);
                }
                return jsonResponse(request, env, { ok: false, message: 'Method Not Allowed' }, 405);
            }

            return jsonResponse(request, env, { ok: false, message: 'Not Found' }, 404);
        } catch (err) {
            return jsonResponse(
                request,
                env,
                { ok: false, message: `服务端内部错误：${err?.message || String(err)}` },
                500
            );
        }
    },
    async scheduled(_event, env) {
        if (!env.DB || !env.SYNC_TOKEN?.trim() || !env.VAPID_PUBLIC_KEY) return;
        await ensureSchema(env.DB);
        await sendMyListReminders(env, Date.now());
    },
};
