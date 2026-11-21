-- Cloudflare D1 (SQLite) schema for personal tools cloud sync and MyList reminders.
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

-- Per-installation opt-ins. Revoked IDs remain with an empty sync_key.
CREATE TABLE IF NOT EXISTS mylist_push_clients (
    client_id  TEXT PRIMARY KEY,
    endpoint   TEXT UNIQUE,
    p256dh     TEXT NOT NULL DEFAULT '',
    auth       TEXT NOT NULL DEFAULT '',
    sync_key   TEXT NOT NULL DEFAULT '',
    enabled_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_mylist_push_sync_key ON mylist_push_clients(sync_key);

-- Per-installation scheduled reminder deduplication
CREATE TABLE IF NOT EXISTS reminder_logs (
    reminder_key TEXT PRIMARY KEY,
    app_id       TEXT NOT NULL,
    item_id      TEXT NOT NULL,
    sent_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reminder_logs_sent_at ON reminder_logs(sent_at);
