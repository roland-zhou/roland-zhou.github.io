/**
 * MyList data model: MyMind-compatible trailing date parsing & expansion,
 * strict zone invariants, localStorage persistence & undo stack.
 */

export const STORAGE_KEY = 'mylist:v1:state';

const MAX_UNDO = 40;
const DAY = 864e5;
const TOMBSTONE_TTL = 90 * DAY;
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const pad2 = n => String(n).padStart(2, '0');
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
// Weeks start on Monday: Monday = 0 ... Sunday = 6
const weekday = d => (d.getDay() + 6) % 7;

export function uid() {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/** Return YYYY-MM-DD in local timezone (for export filenames / day rollover). */
export function toDateStr(date = new Date()) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function formatMD(date) {
    return `${pad2(date.getMonth() + 1)}.${pad2(date.getDate())}`;
}

// Trailing deadline: "MM-DD", "MM.DD", "M.D", "M-D", optionally followed by "HH:MM" / "H:MM".
const DUE_RE = /(^|\s)(\d{1,2})[-.](\d{1,2})(?:\s+(\d{1,2})[:：](\d{2}))?$/;
const REPEAT_RE = /\s+(rd|rw|rm)$/i;

// Quick dates typed at the end of a title, expanded to canonical "MM.DD" (or "MM.DD HH:MM") on save:
// - English (MyMind): today, tmr, tomorrow, mon..sun, next mon..sun
// - Chinese (after whitespace): 今天, 明天, 后天
const QUICK_DUE_RE = /(^|\s)(today|tmr|tomorrow|今天|明天|后天|(?:next\s+)?(?:mon|tue|wed|thu|fri|sat|sun))(?:\s+(\d{1,2})[:：](\d{2}))?$/i;

// Trailing bare time ("23:32", "9:05", "23：32") without a date -> defaults to today ("MM.DD HH:MM").
const TIME_ONLY_RE = /(^|\s)(\d{1,2})[:：](\d{2})$/;

/**
 * Parse a trailing deadline from text.
 * Returns { index, month, day, hour, minute, timed, repeat? } or null.
 */
export function parseDue(text) {
    if (typeof text !== 'string') return null;
    const trimmed = text.trimEnd();
    const m = DUE_RE.exec(trimmed);
    if (!m) return null;
    const month = +m[2];
    const day = +m[3];
    const timed = m[4] !== undefined;
    const hour = timed ? +m[4] : 0;
    const minute = timed ? +m[5] : 0;
    // Allow 02-29 since some year has it; exact year is picked by dueDate().
    if (month < 1 || month > 12 || day < 1 || day > new Date(2024, month, 0).getDate()) return null;
    if (hour > 23 || minute > 59) return null;
    const index = m.index + m[1].length;
    const prefix = trimmed.slice(0, index).trimEnd();
    const repeat = REPEAT_RE.exec(prefix);
    return {
        index: repeat ? repeat.index : index,
        month, day, hour, minute, timed,
        ...(repeat && { repeat: repeat[1].toLowerCase() }),
    };
}

/** Recurring tasks keep the year of their current occurrence across reloads. */
export function parseTaskDue(item) {
    const due = parseDue(item.text);
    const year = item.repeatYear;
    if (due?.repeat && Number.isInteger(year) && year >= 100 && year <= 9999 &&
        due.day <= new Date(year, due.month, 0).getDate()) {
        due.year = year;
    }
    return due;
}

/**
 * Expand trailing quick dates ("tmr", "next mon", "明天 9:30") AND normalize
 * single-digit numeric dates ("11.5 9:00") into canonical "MM.DD" / "MM.DD HH:MM".
 */
export function expandQuickDue(text, now = new Date()) {
    if (typeof text !== 'string') return '';
    const trimmed = text.trim();
    if (!trimmed) return '';

    const qm = QUICK_DUE_RE.exec(trimmed);
    if (qm) {
        const word = qm[2].toLowerCase();
        let offset;
        if (word === 'today' || word === '今天') offset = 0;
        else if (word === 'tmr' || word === 'tomorrow' || word === '明天') offset = 1;
        else if (word === '后天') offset = 2;
        else {
            const next = word.startsWith('next');
            offset = WEEKDAYS.indexOf(word.slice(-3)) - weekday(now);
            if (next) offset += 7;
            else if (offset < 0) offset += 7;
        }
        let time = '';
        if (qm[3] !== undefined) {
            const hour = +qm[3];
            const minute = +qm[4];
            if (hour > 23 || minute > 59) return trimmed;
            time = ` ${pad2(hour)}:${pad2(minute)}`;
        }
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
        const prefix = trimmed.slice(0, qm.index + qm[1].length);
        return `${prefix}${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}${time}`;
    }

    // Normalize numeric trailing date (e.g. "12.5 9:30" -> "12.05 09:30")
    const dm = DUE_RE.exec(trimmed);
    if (dm) {
        const parsed = parseDue(trimmed);
        if (parsed) {
            const dateIndex = dm.index + dm[1].length;
            const sep = trimmed[dateIndex + dm[2].length];
            const time = parsed.timed ? ` ${pad2(parsed.hour)}:${pad2(parsed.minute)}` : '';
            const prefix = trimmed.slice(0, dateIndex);
            return `${prefix}${pad2(parsed.month)}${sep}${pad2(parsed.day)}${time}`;
        }
    }

    // Bare trailing time ("23:32" / "9:05") -> default to today's date ("MM.DD HH:MM")
    const tm = TIME_ONLY_RE.exec(trimmed);
    if (tm) {
        const hour = +tm[2];
        const minute = +tm[3];
        if (hour <= 23 && minute <= 59) {
            const prefix = trimmed.slice(0, tm.index + tm[1].length);
            return `${prefix}${pad2(now.getMonth() + 1)}.${pad2(now.getDate())} ${pad2(hour)}:${pad2(minute)}`;
        }
    }

    return REPEAT_RE.test(trimmed) ? `${trimmed} ${formatMD(now)}` : trimmed;
}

/** Return the clean display title without its trailing deadline token. */
export function stripDue(text) {
    const due = parseDue(text);
    if (!due) return text;
    return text.slice(0, due.index).trimEnd();
}

/**
 * A date without a stored year is resolved to the occurrence closest to `now`.
 */
export function dueDate(due, now = new Date()) {
    if (due.year !== undefined) {
        return new Date(due.year, due.month - 1, due.day, due.hour, due.minute);
    }
    let best = null;
    const year = now.getFullYear();
    // A date without a year can be February 29 even in a non-leap year.
    const span = due.month === 2 && due.day === 29 ? 4 : 1;
    for (let y = year - span; y <= year + span; y++) {
        const d = new Date(y, due.month - 1, due.day, due.hour, due.minute);
        if (d.getMonth() !== due.month - 1) continue; // 02-29 in non-leap year
        if (!best || Math.abs(d - now) < Math.abs(best - now)) best = d;
    }
    return best;
}

/**
 * Friendlier name for dates near now (matches MyMind):
 * 昨天 / 今天 / 明天, or weekday in last/this/next/after-next week; else null ("MM.DD").
 */
export function dueDayLabel(date, now = new Date()) {
    const diff = Math.round((startOfDay(date) - startOfDay(now)) / DAY);
    const names = { '-1': '昨天', 0: '今天', 1: '明天' };
    if (names[diff]) return names[diff];
    const name = '一二三四五六日'[weekday(date)];
    const week = Math.floor((weekday(now) + diff) / 7);
    const prefix = { '-1': '上', 0: '', 1: '下', 2: '下下' }[week];
    return prefix === undefined ? null : `${prefix}周${name}`;
}

/**
 * Deadline urgency status (matches MyMind):
 * { state: 'overdue' | 'today' | 'upcoming', days, hours? }
 */
export function dueStatus(due, now = new Date()) {
    const date = dueDate(due, now);
    const ahead = Math.round((startOfDay(date) - startOfDay(now)) / DAY);
    if (due.timed && date <= now) {
        return {
            state: 'overdue',
            days: Math.floor((now - date) / DAY),
            hours: Math.floor((now - date) / 36e5),
        };
    }
    if (ahead < 0) return { state: 'overdue', days: -ahead };
    return ahead === 0 ? { state: 'today', days: 0 } : { state: 'upcoming', days: ahead };
}

/** True when `due` is strictly in the future (tomorrow or later -> Scheduled). */
export function isFutureDue(due, now = new Date()) {
    return Boolean(due) && dueStatus(due, now).state === 'upcoming';
}

function setRepeatDate(item, due, now, previous = null) {
    if (!due?.repeat) {
        delete item.repeatYear;
        delete item.repeatDay;
        return;
    }
    const sameDate = previous && due.month === previous.month && due.day === previous.day;
    item.repeatYear = sameDate && previous.year !== undefined ? previous.year : dueDate(due, now).getFullYear();
    if (due.repeat === 'rm') {
        item.repeatDay = sameDate && previous.repeat === 'rm' ? (item.repeatDay ?? due.day) : due.day;
    } else {
        delete item.repeatDay;
    }
}

function advanceRepeat(item, due, now) {
    const date = dueDate(due, now);
    if (due.repeat === 'rm') {
        const day = item.repeatDay ?? due.day;
        date.setDate(1);
        date.setMonth(date.getMonth() + 1);
        date.setDate(Math.min(day, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()));
        item.repeatDay = day;
    } else {
        date.setDate(date.getDate() + (due.repeat === 'rw' ? 7 : 1));
    }
    item.repeatYear = date.getFullYear();
    const time = due.timed ? ` ${pad2(due.hour)}:${pad2(due.minute)}` : '';
    const title = item.text.slice(0, due.index).trimEnd();
    item.text = `${title} ${due.repeat} ${formatMD(date)}${time}`;
    item.zone = isFutureDue(parseTaskDue(item), now) ? 'scheduled' : 'now';
}

function cloneItems(items) {
    return items.map(item => ({ ...item }));
}

function cleanDeleted(raw, nowTs = Date.now()) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [id, ts] of Object.entries(raw)) {
        const n = Number(ts);
        if (typeof id === 'string' && id && Number.isFinite(n) && nowTs - n < TOMBSTONE_TTL) {
            out[id] = n;
        }
    }
    return out;
}

function normalizeItem(raw, now = new Date()) {
    let text = typeof raw.text === 'string' ? raw.text.trim() : '';
    // Migrate legacy items that stored a separate `dueDate: "YYYY-MM-DD"` field
    if (text && typeof raw.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.dueDate) && !parseDue(text)) {
        const [, mm, dd] = raw.dueDate.split('-');
        text = `${text} ${mm}.${dd}`;
    }
    const due = parseTaskDue({ text, repeatYear: raw.repeatYear });
    let zone;
    if (due) {
        zone = isFutureDue(due, now) ? 'scheduled' : 'now';
    } else {
        zone = raw.zone === 'someday' ? 'someday' : 'now';
    }
    const ts = now.getTime();
    return {
        id: typeof raw.id === 'string' && raw.id ? raw.id : uid(),
        text,
        note: typeof raw.note === 'string' ? raw.note : '',
        zone,
        done: Boolean(raw.done),
        doneAt: raw.done ? (Number(raw.doneAt) || ts) : null,
        createdAt: Number(raw.createdAt) || ts,
        updatedAt: Number(raw.updatedAt) || ts,
        order: Number.isFinite(raw.order) ? raw.order : 0,
        ...(due?.year !== undefined && { repeatYear: due.year }),
        ...(due?.repeat === 'rm' && Number.isInteger(raw.repeatDay) &&
            raw.repeatDay >= due.day && raw.repeatDay <= 31 && { repeatDay: raw.repeatDay }),
    };
}

export class MyListStore {
    constructor() {
        this.items = [];
        this.deleted = {};
        this.undoStack = [];
        this.listeners = new Set();
        this.load();
    }

    subscribe(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    emit(meta = {}) {
        this.persist();
        for (const fn of this.listeners) fn(meta);
    }

    load(now = new Date()) {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) {
                this.items = [];
                this.deleted = {};
                return;
            }
            const parsed = JSON.parse(raw);
            const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.items) ? parsed.items : []);
            let migrated = false;
            this.items = list.map(r => {
                const n = normalizeItem(r, now);
                if (r && r.zone === 'scheduled' && n.zone === 'now') migrated = true;
                return n;
            }).filter(t => t.text.length > 0);
            this.deleted = cleanDeleted(parsed?.deleted, now.getTime());
            this._normalizeOrders('now');
            this._normalizeOrders('someday');
            if (migrated) this.persist();
        } catch {
            this.items = [];
            this.deleted = {};
        }
    }

    persist() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                version: 2,
                items: this.items,
                deleted: this.deleted,
            }));
        } catch {
            // Ignore quota errors
        }
    }

    getSyncSnapshot(now = new Date()) {
        return {
            version: 2,
            items: cloneItems(this.items),
            deleted: cleanDeleted(this.deleted, now.getTime()),
        };
    }

    applyRemoteState(data, now = new Date()) {
        const rawList = Array.isArray(data?.items) ? data.items : [];
        this.items = rawList.map(r => normalizeItem(r, now)).filter(t => t.text.length > 0);
        this.deleted = cleanDeleted(data?.deleted, now.getTime());
        this._normalizeOrders('now');
        this._normalizeOrders('someday');
        this.emit({ type: 'remote-sync' });
    }

    _pushUndo(label = '', repeatId = null) {
        this.undoStack.push({
            label,
            repeatId,
            items: cloneItems(this.items),
            deleted: { ...this.deleted },
        });
        if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    }

    canUndo() {
        return this.undoStack.length > 0;
    }

    undo() {
        if (!this.undoStack.length) return null;
        const snap = this.undoStack.pop();
        const prevDeleted = this.deleted;
        const nowTs = Date.now();
        // Bump updatedAt on resurrected items so cloud sync won't re-delete them with an older tombstone.
        for (const item of snap.items) {
            if (prevDeleted[item.id] && prevDeleted[item.id] >= (item.updatedAt || 0)) {
                item.updatedAt = nowTs;
            }
            if (item.id === snap.repeatId) {
                const current = this.getById(item.id);
                item.updatedAt = Math.max(nowTs, (current?.updatedAt ?? item.updatedAt) + 1);
            }
        }
        this.items = snap.items;
        this.deleted = snap.deleted ? { ...snap.deleted } : {};
        this.emit({ type: 'undo', label: snap.label });
        return snap.label;
    }

    _normalizeOrders(zone) {
        const active = this.items
            .filter(t => !t.done && t.zone === zone)
            .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
        active.forEach((t, i) => { t.order = i; });
    }

    /** Active tasks in 'now' (top -> bottom; bottom-most is newest / highest order). */
    getNowItems() {
        return this.items
            .filter(t => !t.done && t.zone === 'now')
            .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
    }

    /**
     * Active tasks in 'scheduled' (strictly future dates, sorted by due timestamp DESC:
     * furthest future at TOP, closest future at BOTTOM).
     */
    getScheduledItems(now = new Date()) {
        return this.items
            .filter(t => !t.done && t.zone === 'scheduled' && isFutureDue(parseTaskDue(t), now))
            .sort((a, b) => {
                const ta = dueDate(parseTaskDue(a), now).getTime();
                const tb = dueDate(parseTaskDue(b), now).getTime();
                if (ta !== tb) return tb - ta;
                return b.createdAt - a.createdAt;
            });
    }

    /**
     * Automatically drop any 'scheduled' tasks whose date has become today or past down into 'now'.
     * Returns the list of moved items.
     */
    syncDueZones(now = new Date()) {
        const arrived = this.items
            .filter(t => !t.done && t.zone === 'scheduled' && !isFutureDue(parseTaskDue(t), now));
        if (!arrived.length) return [];

        // Order arrived items so the earliest/most-urgent lands at the very bottom of 'now'
        arrived.sort((a, b) => {
            const da = parseTaskDue(a);
            const db = parseTaskDue(b);
            const ta = da ? dueDate(da, now).getTime() : 0;
            const tb = db ? dueDate(db, now).getTime() : 0;
            if (ta !== tb) return tb - ta;
            return b.createdAt - a.createdAt;
        });

        const nowList = this.getNowItems();
        let nextOrder = nowList.length ? nowList[nowList.length - 1].order + 1 : 0;
        for (const item of arrived) {
            item.zone = 'now';
            item.order = nextOrder++;
            item.updatedAt = now.getTime();
        }
        this._normalizeOrders('now');
        this.emit({ type: 'due-arrived', ids: arrived.map(t => t.id), count: arrived.length });
        return arrived;
    }

    /** Active tasks in 'someday' (top -> bottom; bottom-most is newest / highest order). */
    getSomedayItems() {
        return this.items
            .filter(t => !t.done && t.zone === 'someday')
            .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
    }

    getDoneItems() {
        return this.items
            .filter(t => t.done)
            .sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    }

    getById(id) {
        return this.items.find(t => t.id === id) || null;
    }

    /**
     * Add a new task.
     * Trailing quick dates ("tmr", "next mon", "11.25 14:00") are automatically expanded.
     * - Future date (tomorrow or later) -> 'scheduled' (strict date order).
     * - Today, past date, or undated -> 'now' at the very bottom (pushing earlier items up).
     */
    addTask(rawText, { zone = 'now', now = new Date() } = {}) {
        const expanded = expandQuickDue(rawText, now);
        if (!expanded) return null;
        this._pushUndo('添加任务');

        const due = parseDue(expanded);
        const targetZone = isFutureDue(due, now)
            ? 'scheduled'
            : (due ? 'now' : (zone === 'someday' ? 'someday' : 'now'));
        const ts = now.getTime();

        let order = 0;
        if (targetZone === 'now') {
            const list = this.getNowItems();
            order = list.length ? list[list.length - 1].order + 1 : 0;
        } else if (targetZone === 'someday') {
            const list = this.getSomedayItems();
            order = list.length ? list[list.length - 1].order + 1 : 0;
        }

        const item = {
            id: uid(),
            text: expanded,
            note: '',
            zone: targetZone,
            done: false,
            doneAt: null,
            createdAt: ts,
            updatedAt: ts,
            order,
        };
        setRepeatDate(item, due, now);
        this.items.push(item);
        if (targetZone !== 'scheduled') this._normalizeOrders(targetZone);
        this.emit({ type: 'add', id: item.id, zone: targetZone });
        return item;
    }

    updateTask(id, patch = {}, now = new Date()) {
        const item = this.getById(id);
        if (!item) return null;
        this._pushUndo('修改任务');

        const prevZone = item.zone;
        if (typeof patch.text === 'string') {
            const expanded = expandQuickDue(patch.text, now);
            if (expanded) {
                const previous = parseDue(patch.text) ? parseTaskDue(item) : null;
                item.text = expanded;
                setRepeatDate(item, parseDue(expanded), now, previous);
            }
        }
        if (typeof patch.note === 'string') {
            item.note = patch.note.trim() ? patch.note.replace(/\s+$/, '') : '';
        }

        const due = parseTaskDue(item);
        if (isFutureDue(due, now)) {
            item.zone = 'scheduled';
        } else if (due) {
            // Today or past dated tasks belong in 'now'
            item.zone = 'now';
        } else if (patch.zone === 'someday' || patch.zone === 'now') {
            item.zone = patch.zone;
        } else if (prevZone === 'scheduled') {
            item.zone = 'now';
        }

        if (item.zone !== prevZone) {
            if (item.zone === 'now') {
                const list = this.getNowItems().filter(t => t.id !== id);
                item.order = list.length ? list[list.length - 1].order + 1 : 0;
            } else if (item.zone === 'someday') {
                const list = this.getSomedayItems().filter(t => t.id !== id);
                item.order = list.length ? list[list.length - 1].order + 1 : 0;
            }
        }

        item.updatedAt = now.getTime();
        this._normalizeOrders('now');
        this._normalizeOrders('someday');
        this.emit({ type: 'update', id, zone: item.zone, prevZone });
        return item;
    }

    toggleDone(id, now = new Date()) {
        const item = this.getById(id);
        if (!item) return null;
        const due = parseTaskDue(item);
        if (!item.done && due?.repeat) {
            this._pushUndo('推进循环任务', id);
            advanceRepeat(item, due, now);
            item.updatedAt = Math.max(now.getTime(), item.updatedAt + 1);
            this._normalizeOrders('now');
            this.emit({ type: 'repeat', id, zone: item.zone });
            return item;
        }
        this._pushUndo(item.done ? '恢复任务' : '完成任务');
        item.done = !item.done;
        item.doneAt = item.done ? now.getTime() : null;
        item.updatedAt = now.getTime();

        if (!item.done && item.zone === 'now') {
            const list = this.getNowItems().filter(t => t.id !== id);
            item.order = list.length ? list[list.length - 1].order + 1 : 0;
        }
        this._normalizeOrders('now');
        this._normalizeOrders('someday');
        this.emit({ type: item.done ? 'complete' : 'restore', id, zone: item.zone });
        return item;
    }

    deleteTask(id) {
        const idx = this.items.findIndex(t => t.id === id);
        if (idx === -1) return false;
        this._pushUndo('删除任务');
        const [removed] = this.items.splice(idx, 1);
        this.deleted[id] = Date.now();
        this._normalizeOrders('now');
        this._normalizeOrders('someday');
        this.emit({ type: 'delete', id, zone: removed.zone });
        return true;
    }

    clearDone() {
        if (!this.items.some(t => t.done)) return false;
        this._pushUndo('清空已完成');
        const nowTs = Date.now();
        for (const t of this.items) {
            if (t.done) this.deleted[t.id] = nowTs;
        }
        this.items = this.items.filter(t => !t.done);
        this.emit({ type: 'clear-done' });
        return true;
    }

    /**
     * Reorder within 'now' or 'someday', OR move between 'now' and 'someday'.
     * Never allowed for 'scheduled' items (strictly chronological).
     */
    moveItem(id, targetZone, targetIndex = null) {
        const item = this.getById(id);
        if (!item || item.done) return false;
        if (item.zone === 'scheduled' || targetZone === 'scheduled') return false;
        const due = targetZone === 'someday' ? parseTaskDue(item) : null;
        if (due?.repeat) return false;

        const prevZone = item.zone;
        const targetList = (targetZone === 'now' ? this.getNowItems() : this.getSomedayItems())
            .filter(t => t.id !== id);

        let idx;
        if (targetIndex === null || targetIndex === undefined) {
            idx = targetList.length;
        } else {
            idx = Math.max(0, Math.min(targetIndex, targetList.length));
        }

        if (prevZone === targetZone) {
            const currentList = targetZone === 'now' ? this.getNowItems() : this.getSomedayItems();
            if (currentList.findIndex(t => t.id === id) === idx) return false;
        }

        this._pushUndo(prevZone === targetZone ? '调整顺序' : (targetZone === 'someday' ? '移到以后再做' : '移到现在'));
        // If a today/overdue task from 'now' is deliberately moved up to 'someday', strip its past/today date
        if (due) {
            const cleaned = stripDue(item.text);
            if (cleaned) item.text = cleaned;
        }
        item.zone = targetZone;
        item.updatedAt = Date.now();

        targetList.splice(idx, 0, item);
        targetList.forEach((t, i) => { t.order = i; });
        if (prevZone !== targetZone) this._normalizeOrders(prevZone);

        this.emit({ type: 'move', id, zone: targetZone, prevZone });
        return true;
    }

    loadSamples(now = new Date()) {
        this._pushUndo('载入示例');
        const ts = now.getTime();
        const plus = days => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);

        const samples = [
            // Someday (top 1/4)
            { text: '整理去年的旅行照片并做一本相册', zone: 'someday', order: 0 },
            { text: '研究家里阳台种香草的方案', zone: 'someday', order: 1 },
            // Scheduled (second 1/4: strictly future dates, furthest at top, soonest at bottom)
            { text: `体检预约与年度复查 ${formatMD(plus(18))}`, zone: 'scheduled' },
            { text: `准备下周项目评审材料 ${formatMD(plus(4))} 14:00`, zone: 'scheduled' },
            { text: `给信用卡设置自动还款 ${formatMD(plus(1))}`, zone: 'scheduled' },
            // Now (bottom 1/2: undated immediate tasks + today/past dated tasks)
            { text: '回复设计稿评审的几条评论', zone: 'now', order: 0 },
            { text: `提交本月差旅报销单 ${formatMD(plus(0))}`, zone: 'now', order: 1 },
            { text: '把今天最重要的 1 件事先开头', zone: 'now', order: 2 },
        ];
        samples.forEach((s, i) => {
            this.items.push({
                id: uid(),
                text: s.text,
                note: s.note || '',
                zone: s.zone,
                done: false,
                doneAt: null,
                createdAt: ts + i * 10,
                updatedAt: ts + i * 10,
                order: s.order ?? 0,
            });
        });
        this._normalizeOrders('now');
        this._normalizeOrders('someday');
        this.emit({ type: 'sample' });
    }

    exportJSON() {
        return JSON.stringify({
            app: 'MyList',
            version: 2,
            exportedAt: new Date().toISOString(),
            items: this.items,
        }, null, 2);
    }

    exportMarkdown() {
        const lines = ['# MyList', ''];
        const nowList = this.getNowItems();
        const scheduledList = this.getScheduledItems();
        const somedayList = this.getSomedayItems();
        const doneList = this.getDoneItems();

        const appendTask = (t, checked = false) => {
            lines.push(`- [${checked ? 'x' : ' '}] ${t.text}`);
            if (t.note) {
                for (const nl of t.note.split('\n')) {
                    lines.push(`  > ${nl}`);
                }
            }
        };

        lines.push('## 现在');
        if (nowList.length) nowList.forEach(t => appendTask(t, false));
        else lines.push('_空_');

        lines.push('', '## 日程规划');
        if (scheduledList.length) scheduledList.forEach(t => appendTask(t, false));
        else lines.push('_空_');

        lines.push('', '## 以后再做');
        if (somedayList.length) somedayList.forEach(t => appendTask(t, false));
        else lines.push('_空_');

        if (doneList.length) {
            lines.push('', '## 已完成');
            doneList.forEach(t => appendTask(t, true));
        }
        return lines.join('\n') + '\n';
    }

    importJSON(jsonText) {
        const parsed = JSON.parse(jsonText);
        const rawList = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.items) ? parsed.items : null);
        if (!rawList) throw new Error('无效的 MyList 数据格式');
        this._pushUndo('导入数据');
        const now = new Date();
        this.items = rawList.map(raw => normalizeItem(raw, now)).filter(t => t.text.length > 0);
        this._normalizeOrders('now');
        this._normalizeOrders('someday');
        this.emit({ type: 'import' });
        return this.items.length;
    }
}

function canonicalListPayload(items, deleted, now) {
    const normalized = items.map(r => normalizeItem(r, now)).filter(t => t.text.length > 0);
    for (const zone of ['now', 'someday']) {
        const active = normalized
            .filter(t => !t.done && t.zone === zone)
            .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
        active.forEach((t, i) => { t.order = i; });
    }
    normalized.sort((a, b) => a.id.localeCompare(b.id));
    const sortedDeleted = {};
    for (const id of Object.keys(deleted).sort()) {
        sortedDeleted[id] = deleted[id];
    }
    return { version: 2, items: normalized, deleted: sortedDeleted };
}

/**
 * Pure two-way item-level LWW merge for MyList cloud sync.
 * - Uses `updatedAt` per item so offline edits to different items on different devices merge seamlessly.
 * - Propagates deletions via `deleted` tombstones (pruned after 90 days).
 */
export function mergeListStates(local, remote, { now = new Date() } = {}) {
    const nowTs = now.getTime();
    const localItems = (Array.isArray(local?.items) ? local.items : [])
        .map(r => normalizeItem(r, now)).filter(t => t.text.length > 0);
    const remoteItems = (Array.isArray(remote?.items) ? remote.items : [])
        .map(r => normalizeItem(r, now)).filter(t => t.text.length > 0);

    const localDel = cleanDeleted(local?.deleted, nowTs);
    const remoteDel = cleanDeleted(remote?.deleted, nowTs);

    const deleted = { ...localDel };
    for (const [id, ts] of Object.entries(remoteDel)) {
        deleted[id] = Math.max(deleted[id] || 0, ts);
    }

    const localById = new Map(localItems.map(t => [t.id, t]));
    const remoteById = new Map(remoteItems.map(t => [t.id, t]));
    const allIds = new Set([...localById.keys(), ...remoteById.keys()]);
    const mergedItems = [];

    for (const id of allIds) {
        const li = localById.get(id);
        const ri = remoteById.get(id);
        const delTs = deleted[id] || 0;

        if (li && !ri) {
            if (delTs >= (li.updatedAt || 0)) continue;
            if (delTs) delete deleted[id];
            mergedItems.push({ ...li });
        } else if (ri && !li) {
            if (delTs >= (ri.updatedAt || 0)) continue;
            if (delTs) delete deleted[id];
            mergedItems.push({ ...ri });
        } else if (li && ri) {
            const lt = li.updatedAt || 0;
            const rt = ri.updatedAt || 0;
            if (delTs >= Math.max(lt, rt)) continue;
            if (delTs) delete deleted[id];

            if (lt > rt) {
                mergedItems.push({ ...li });
            } else if (rt > lt) {
                mergedItems.push({ ...ri });
            } else {
                // Deterministic tie-breaker when timestamps are identical
                const ls = JSON.stringify(li);
                const rs = JSON.stringify(ri);
                mergedItems.push(ls >= rs ? { ...li } : { ...ri });
            }
        }
    }

    const merged = canonicalListPayload(mergedItems, deleted, now);
    const origLocal = canonicalListPayload(localItems, localDel, now);
    const origRemote = canonicalListPayload(remoteItems, remoteDel, now);

    const mergedStr = JSON.stringify(merged);
    return {
        merged,
        localChanged: mergedStr !== JSON.stringify(origLocal),
        remoteChanged: mergedStr !== JSON.stringify(origRemote),
    };
}
