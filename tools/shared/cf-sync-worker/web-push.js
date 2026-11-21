const encoder = new TextEncoder();

function decode64(value) {
    return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
}

function encode64(bytes) {
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function joinBytes(...parts) {
    const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}

export async function syncKey(token) {
    return encode64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token.trim()))));
}

export function validPushEndpoint(endpoint) {
    if (typeof endpoint !== 'string' || endpoint.length > 2048) return false;
    try {
        const url = new URL(endpoint);
        return url.href === endpoint && url.protocol === 'https:' && !url.port && !url.username &&
            !url.password && !url.hash && /^[a-z0-9-]+\.push\.apple\.com$/.test(url.hostname);
    } catch {
        return false;
    }
}

export function validSubscriptionKeys(p256dh, auth) {
    return validPublicKey(p256dh) && typeof auth === 'string' && /^[A-Za-z0-9_-]{22}$/.test(auth);
}

function validPublicKey(key) {
    return typeof key === 'string' && /^[A-Za-z0-9_-]{87}$/.test(key) && decode64(key)[0] === 4;
}

export async function loadVapid(env) {
    const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: subject } = env;
    if (!validPublicKey(publicKey) ||
        !/^[A-Za-z0-9_-]{43}$/.test(privateKey) || !/^(mailto:.+@.+|https:\/\/.+)$/.test(subject)) {
        return null;
    }
    const point = decode64(publicKey);
    const key = await crypto.subtle.importKey('jwk', {
        kty: 'EC', crv: 'P-256', d: privateKey,
        x: encode64(point.slice(1, 33)), y: encode64(point.slice(33)),
    }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    return { publicKey, subject, key };
}

async function encryptPayload(client, notification) {
    // RFC 8291, using a fresh ECDH key and salt for each single-record message.
    const peerPoint = decode64(client.p256dh);
    const peerKey = await crypto.subtle.importKey('raw', peerPoint, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const serverKey = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const serverPoint = new Uint8Array(await crypto.subtle.exportKey('raw', serverKey.publicKey));
    const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerKey }, serverKey.privateKey, 256);
    const hkdf = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
    const ikm = await crypto.subtle.deriveBits({
        name: 'HKDF', hash: 'SHA-256', salt: decode64(client.auth),
        info: joinBytes(encoder.encode('WebPush: info\0'), peerPoint, serverPoint),
    }, hkdf, 256);
    const ikmKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const derive = (info, bits) => crypto.subtle.deriveBits({
        name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(info),
    }, ikmKey, bits);
    const [keyBytes, nonce] = await Promise.all([
        derive('Content-Encoding: aes128gcm\0', 128),
        derive('Content-Encoding: nonce\0', 96),
    ]);
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
    const data = joinBytes(encoder.encode(JSON.stringify(notification)), Uint8Array.of(2));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, data);

    // Salt, big-endian record size (4096), key ID length, then the ECDH public point.
    return joinBytes(salt, Uint8Array.of(0, 0, 16, 0, serverPoint.length), serverPoint, new Uint8Array(ciphertext));
}

export async function preparePushRequest(client, notification, topic, vapid) {
    const aud = new URL(client.endpoint).origin;
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = [
        { typ: 'JWT', alg: 'ES256' }, { aud, exp, sub: vapid.subject },
    ].map((part) => encode64(encoder.encode(JSON.stringify(part)))).join('.');
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, vapid.key, encoder.encode(jwt));
    return new Request(client.endpoint, {
        method: 'POST',
        headers: {
            Authorization: `vapid t=${jwt}.${encode64(new Uint8Array(signature))}, k=${vapid.publicKey}`,
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            TTL: '0',
            Urgency: 'high',
            Topic: topic,
        },
        body: await encryptPayload(client, notification),
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
    });
}
