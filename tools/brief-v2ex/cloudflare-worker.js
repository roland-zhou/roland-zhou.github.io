// Cloudflare Worker: CORS proxy for V2EX.
//
// Deploy:
//   1. Create a free Cloudflare account (cloudflare.com).
//   2. Workers & Pages → Create → Hello World → name it (e.g. "v2ex-proxy") → Deploy.
//   3. Edit code → paste this file → Save and Deploy.
//   4. Copy the *.workers.dev URL and append "/?url=" — e.g.
//      https://v2ex-proxy.<your-subdomain>.workers.dev/?url=
//   5. Paste that into Brief V2EX → Settings → "CORS proxy prefix" and Save.
//
// Free tier: 100k requests/day. Egress is free.
//
// Convention: the client passes the target URL URL-encoded in `?url=...`.
// Only v2ex.com hosts are allowed, so the worker can't be used as an open proxy.

const ALLOWED_HOSTS = new Set(['www.v2ex.com', 'v2ex.com']);

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
};

// Wrap every response so CORS headers are guaranteed even on errors.
// Without this, an unhandled throw produces a Cloudflare error page that
// lacks Access-Control-Allow-Origin, and the browser blocks it.
function corsResponse(body, init = {}) {
    const headers = new Headers(init.headers || {});
    for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
    return new Response(body, { ...init, headers });
}

export default {
    async fetch(request) {
        try {
            if (request.method === 'OPTIONS') {
                return corsResponse(null, { status: 204 });
            }
            if (request.method !== 'GET') {
                return corsResponse('Method not allowed', { status: 405 });
            }

            const target = new URL(request.url).searchParams.get('url');
            if (!target) {
                return corsResponse('Missing ?url= parameter', { status: 400 });
            }

            let parsed;
            try {
                parsed = new URL(target);
            } catch {
                return corsResponse('Invalid url', { status: 400 });
            }
            if (!ALLOWED_HOSTS.has(parsed.hostname)) {
                return corsResponse(`Host not allowed: ${parsed.hostname}`, { status: 403 });
            }

            // Forward Authorization (for V2EX v2 PAT) but strip everything else —
            // notably the Cookie/Origin/Referer chain, which V2EX sometimes treats
            // as a signed-in session and rate-limits differently.
            const headers = new Headers();
            const auth = request.headers.get('Authorization');
            if (auth) headers.set('Authorization', auth);
            headers.set('User-Agent', 'brief-v2ex-proxy/1.0');
            headers.set('Accept', 'application/json');

            const upstream = await fetch(parsed.toString(), { method: 'GET', headers });

            // Buffer the body so we don't risk a streaming hiccup that drops
            // headers, and pass through Content-Type for correct JSON parsing.
            const text = await upstream.text();
            const init = { status: upstream.status };
            const ct = upstream.headers.get('Content-Type');
            if (ct) init.headers = { 'Content-Type': ct };
            return corsResponse(text, init);
        } catch (err) {
            return corsResponse('Worker error: ' + (err?.message || String(err)), { status: 502 });
        }
    },
};
