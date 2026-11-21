-- Cloudflare D1 (SQLite) schema for personal tools cloud sync & future reminders.
-- Note: worker.js also auto-runs these CREATE TABLE IF NOT EXISTS statements on cold start,
-- so Dashboard deployments work without manually running this SQL file.

-- Synced application state documents (e.g. mylist, mymind)
CREATE TABLE IF NOT EXISTS sync_docs (
    app_id     TEXT PRIMARY KEY,
    payload    TEXT NOT NULL,
    version    INTEGER NOT NULL DEFAULT 1,
    timezone   TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
);

-- Reserved for iOS PWA Web Push subscriptions (next step: scheduled reminders)
CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint   TEXT PRIMARY KEY,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    label      TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Reserved for scheduled reminder deduplication logs
CREATE TABLE IF NOT EXISTS reminder_logs (
    reminder_key TEXT PRIMARY KEY,
    app_id       TEXT NOT NULL,
    item_id      TEXT NOT NULL,
    sent_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reminder_logs_sent_at ON reminder_logs(sent_at);
