import { parseDue } from '../../mylist/model.js';
import { loadVapid, preparePushRequest, syncKey, validPushEndpoint } from './web-push.js';

const MINUTE = 60_000;
const LOOKBACK = 10 * MINUTE;
const LOG_RETENTION = 7 * 864e5;
const MAX_SENDS = 10;

function dueReminders(doc, now) {
    if (!doc?.timezone) return [];
    let formatter;
    try {
        formatter = new Intl.DateTimeFormat('en-GB', {
            timeZone: doc.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        });
    } catch {
        return [];
    }
    const slots = new Map();
    const latest = Math.floor(now / MINUTE) * MINUTE;
    for (let at = latest; at > latest - LOOKBACK; at -= MINUTE) {
        const local = Object.fromEntries(formatter.formatToParts(at).map(({ type, value }) => [type, value]));
        const { year, month, day, hour, minute } = local;
        slots.set(`${+month}/${+day}/${+hour}/${+minute}`, { at, date: `${year}-${month}-${day}T${hour}:${minute}` });
    }
    const data = JSON.parse(doc.payload);
    if (!Array.isArray(data?.items)) return [];
    return data.items.flatMap((item) => {
        if (!item || item.done || typeof item.id !== 'string' || !item.id ||
            Number(data.deleted?.[item.id]) >= Number(item.updatedAt || item.createdAt)) return [];
        const due = parseDue(item.text);
        if (!due?.timed) return [];
        const slot = slots.get(`${due.month}/${due.day}/${due.hour}/${due.minute}`);
        if (!slot || Math.floor(Number(item.createdAt) / MINUTE) * MINUTE > slot.at) return [];
        const body = item.text.slice(0, due.index).trimEnd().slice(0, 140);
        return [{ ...slot, itemId: item.id, body }];
    }).sort((a, b) => a.at - b.at);
}

export async function sendMyListReminders(env, now) {
    const vapid = await loadVapid(env);
    if (!vapid) return;

    const db = env.DB;
    const key = await syncKey(env.SYNC_TOKEN);
    const { results: clients } = await db.prepare(
        'SELECT client_id, endpoint, p256dh, auth, enabled_at FROM mylist_push_clients WHERE sync_key = ?'
    ).bind(key).all();
    if (!clients.length) return;

    const doc = await db.prepare("SELECT payload, timezone FROM sync_docs WHERE app_id = 'mylist'").first();
    const reminders = dueReminders(doc, now);
    if (Math.floor(now / MINUTE) % 1440 === 0) {
        await db.prepare('DELETE FROM reminder_logs WHERE sent_at < ?').bind(now - LOG_RETENTION).run();
    }
    if (!reminders.length) return;

    // Include both occurrences of the same local time during a DST fallback.
    const { results: recent } = await db.prepare("SELECT reminder_key FROM reminder_logs WHERE app_id = 'mylist' AND sent_at >= ?")
        .bind(now - 3 * 3600_000).all();
    const sent = new Set(recent.map(({ reminder_key }) => reminder_key));
    let attempts = 0;
    for (const reminder of reminders) {
        for (const client of clients) {
            if (!validPushEndpoint(client.endpoint) || client.enabled_at >= reminder.at + MINUTE) continue;
            const reminderKey = JSON.stringify([client.client_id, reminder.itemId, reminder.date]);
            if (sent.has(reminderKey)) continue;
            if (attempts++ >= MAX_SENDS) return;

            let claimed = false;
            try {
                const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(reminderKey));
                const topic = Array.from(new Uint8Array(digest).slice(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
                const request = await preparePushRequest(client, {
                    title: 'MyList 到期提醒',
                    body: reminder.body || '有一项任务到期',
                    tag: topic,
                }, topic, vapid);

                // Atomically claim delivery and recheck that this exact subscription is still active.
                const claim = await db.prepare(
                    `INSERT OR IGNORE INTO reminder_logs (reminder_key, app_id, item_id, sent_at)
                     SELECT ?, 'mylist', ?, ? FROM mylist_push_clients
                     WHERE client_id = ? AND sync_key = ? AND endpoint = ? AND p256dh = ? AND auth = ?`
                ).bind(reminderKey, reminder.itemId, now, client.client_id, key, client.endpoint, client.p256dh, client.auth).run();
                if (!claim.meta.changes) continue;
                claimed = true;
                sent.add(reminderKey);
                const response = await fetch(request);
                if (response.ok) {
                    console.info('MyList push accepted', response.status);
                    continue;
                }

                if (response.status === 404 || response.status === 410) {
                    await db.prepare(
                        "UPDATE mylist_push_clients SET endpoint = NULL, p256dh = '', auth = '', sync_key = '' WHERE client_id = ? AND endpoint = ? AND auth = ?"
                    ).bind(client.client_id, client.endpoint, client.auth).run();
                    client.endpoint = null;
                    continue;
                }
                if (response.status === 429 || response.status >= 500) {
                    await db.prepare('DELETE FROM reminder_logs WHERE reminder_key = ?').bind(reminderKey).run();
                }
                console.warn('MyList push returned HTTP', response.status);
            } catch (error) {
                // An interrupted fetch may already have reached Apple. Keep its claim to avoid a duplicate.
                console.warn('MyList push failed', claimed ? 'during delivery' : 'before delivery', error.name);
            }
        }
    }
}
