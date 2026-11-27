// Pure data helpers for MyMind: tree model, layout and OPML.

export const PALETTE_SIZE = 6;
const NS = 'https://rolandzhou.xyz/tools/mymind/';

export function uid() {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export function compareVersions(a, b) {
    const pa = String(a || '').replace(/^v/i, '').split('.').map(n => Number.parseInt(n, 10) || 0);
    const pb = String(b || '').replace(/^v/i, '').split('.').map(n => Number.parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

export function createNode(text = '', extra = {}) {
    return { id: uid(), text, note: '', task: null, children: [], ...extra };
}

export function createMap(title = '中心主题') {
    const now = Date.now();
    return { id: uid(), root: createNode(title), created: now, updated: now };
}

export function isValidNode(node) {
    return Boolean(
        node && typeof node.id === 'string' && typeof node.text === 'string'
        && Array.isArray(node.children) && node.children.every(isValidNode)
    );
}

export function isValidMap(map) {
    return Boolean(map && typeof map.id === 'string' && isValidNode(map.root));
}

export function cloneNode(node) {
    const copy = createNode(node.text, {
        note: typeof node.note === 'string' ? node.note : '',
        task: node.task === 'open' || node.task === 'done' ? node.task : null,
        children: node.children.map(cloneNode),
    });
    if (node.folded && copy.children.length) copy.folded = true;
    if (waitPrefix(copy.text) && Number.isFinite(node.waitSince)) copy.waitSince = node.waitSince;
    return copy;
}

export function nodesToPlainText(nodes) {
    const lines = [];
    const format = (node, depth) => {
        const indent = '  '.repeat(depth);
        lines.push(`${indent}${node.text.replace(/\n/g, `\n${indent}`)}`);
        node.children.forEach(c => format(c, depth + 1));
    };
    nodes.forEach(n => format(n, 0));
    return lines.join('\n');
}

// id -> { node, parent, depth, side, color }. Side and color come from the first-level branch.
export function buildIndex(root) {
    const index = new Map();
    const visit = (node, parent, depth, side, color) => {
        index.set(node.id, { node, parent, depth, side, color });
        if (node.folded) return;
        node.children.forEach((child, i) => {
            const childSide = depth === 0 ? (child.side === 'left' ? 'left' : 'right') : side;
            const childColor = depth === 0 ? (Number.isInteger(child.color) ? child.color : i) : color;
            visit(child, node, depth + 1, childSide, childColor);
        });
    };
    visit(root, null, 0, 'right', 0);
    return index;
}

export function nextColor(root) {
    const counts = new Array(PALETTE_SIZE).fill(0);
    root.children.forEach((c, i) => counts[(Number.isInteger(c.color) ? c.color : i) % PALETTE_SIZE]++);
    let best = 0;
    for (let i = 1; i < PALETTE_SIZE; i++) if (counts[i] < counts[best]) best = i;
    return best;
}

export function countNodes(node) {
    return 1 + node.children.reduce((sum, c) => sum + countNodes(c), 0);
}

export function subtreeIds(node, out = new Set()) {
    out.add(node.id);
    node.children.forEach(c => subtreeIds(c, out));
    return out;
}

export const visibleChildren = node => (node.folded ? [] : node.children);

// Horizontal mind-map layout. Folded nodes hide their children. sizes: id -> { w, h }. Returns id -> { x, y, w, h } with the root centred at 0,0.
export function computeLayout(root, sizes) {
    const ROOT_GAP = 64;
    const GAP = 40;
    const gapBelow = depth => (depth === 0 ? 22 : 8);
    const sub = new Map();
    const block = (kids, depth) =>
        kids.reduce((sum, k) => sum + sub.get(k.id), 0) + Math.max(0, kids.length - 1) * gapBelow(depth);
    const measure = (node, depth) => {
        const kids = visibleChildren(node);
        kids.forEach(c => measure(c, depth + 1));
        const h = sizes.get(node.id).h;
        sub.set(node.id, depth === 0 ? h : Math.max(h, block(kids, depth)));
    };
    measure(root, 0);

    const pos = new Map();
    const place = (node, depth, edgeX, cy, side) => {
        const { w, h } = sizes.get(node.id);
        const x = side === 'right' ? edgeX : edgeX - w;
        pos.set(node.id, { x, y: cy - h / 2, w, h });
        placeKids(visibleChildren(node), depth, side === 'right' ? x + w + GAP : x - GAP, cy, side);
    };
    const placeKids = (kids, depth, edgeX, cy, side) => {
        let top = cy - block(kids, depth) / 2;
        for (const k of kids) {
            const sh = sub.get(k.id);
            place(k, depth + 1, edgeX, top + sh / 2, side);
            top += sh + gapBelow(depth);
        }
    };
    const r = sizes.get(root.id);
    pos.set(root.id, { x: -r.w / 2, y: -r.h / 2, w: r.w, h: r.h });
    placeKids(root.children.filter(c => c.side !== 'left'), 0, r.w / 2 + ROOT_GAP, 0, 'right');
    placeKids(root.children.filter(c => c.side === 'left'), 0, -r.w / 2 - ROOT_GAP, 0, 'left');
    return pos;
}

export function sampleMap() {
    const map = createMap('MyMind');
    map.isSample = true;
    const n = (text, extra = {}, children = []) => createNode(text, { ...extra, children });
    map.root.children = [
        n('快速开始', { side: 'right', color: 0 }, [n('Tab 新建子节点'), n('Enter 新建同级节点'), n('双击或按空格编辑')]),
        n('整理结构', { side: 'right', color: 1 }, [n('拖拽节点换父节点或调整顺序'), n('在空白处拖动可以框选'), n('⌘ + 滚轮缩放画布')]),
        n('待办清单', { side: 'left', color: 2, task: 'open' }, [
            n('点一下圆圈完成待办', { task: 'open' }),
            n('已经完成的事项', { task: 'done' }),
        ]),
        n('备注', { side: 'left', color: 4 }, [
            n('这个节点有备注', { note: '备注会随 OPML 一起导出。' }),
        ]),
        n('文件', { side: 'left', color: 3 }, [n('自动保存在当前浏览器'), n('可导入导出 OPML')]),
    ];
    return map;
}

function esc(value) {
    return String(value)
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
        .replace(/[&<>"\n\r\t]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\n': '&#10;', '\r': '', '\t': '&#9;' }[c]));
}

export function exportOPML(map) {
    const outline = (node, depth, indent) => {
        let attrs = ` text="${esc(node.text)}"`;
        if (node.note) attrs += ` _note="${esc(node.note)}"`;
        if (node.task) attrs += ` _status="${node.task === 'done' ? 'checked' : 'unchecked'}"`;
        if (node.folded && node.children.length) attrs += ' mm:folded="true"';
        if (Number.isFinite(node.waitSince)) attrs += ` mm:waitSince="${new Date(node.waitSince).toISOString()}"`;
        if (depth === 1) {
            attrs += ` mm:side="${node.side === 'left' ? 'left' : 'right'}"`;
            if (Number.isInteger(node.color)) attrs += ` mm:color="${node.color}"`;
        }
        if (!node.children.length) return `${indent}<outline${attrs}/>`;
        return [
            `${indent}<outline${attrs}>`,
            ...node.children.map(c => outline(c, depth + 1, indent + '  ')),
            `${indent}</outline>`,
        ].join('\n');
    };
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<opml version="2.0" xmlns:mm="${NS}">`,
        '  <head>',
        `    <title>${esc(map.root.text || '未命名导图')}</title>`,
        `    <dateModified>${new Date(map.updated || Date.now()).toUTCString()}</dateModified>`,
        '  </head>',
        '  <body>',
        outline(map.root, 0, '    '),
        '  </body>',
        '</opml>',
        '',
    ].join('\n');
}

export function importOPML(text, filename = '') {
    const doc = new DOMParser().parseFromString(text.replace(/^﻿/, ''), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('XML 格式有误');
    const opml = doc.documentElement;
    if (!opml || opml.localName.toLowerCase() !== 'opml') throw new Error('不是 OPML 文件');
    const kids = (el, name) => [...el.children].filter(c => c.localName === name);
    // Match namespaced extras by local name so files from similar tools (e.g. mymind:side) also work.
    const extra = (el, ...names) => {
        for (const a of el.attributes) if (a.prefix && names.includes(a.localName)) return a.value;
        return null;
    };
    const convert = (el, depth, i) => {
        const node = createNode(el.getAttribute('text') ?? el.getAttribute('title') ?? '');
        const note = el.getAttribute('_note') ?? extra(el, 'note');
        if (note) node.note = note;
        const status = el.getAttribute('_status');
        const task = extra(el, 'task');
        if (status === 'checked' || task === 'done') node.task = 'done';
        else if (status === 'unchecked' || task === 'open') node.task = 'open';
        if (['true', '1'].includes(extra(el, 'folded', 'collapsed'))) node.folded = true;
        const waitSince = Date.parse(extra(el, 'waitSince'));
        if (waitPrefix(node.text) && Number.isFinite(waitSince)) node.waitSince = waitSince;
        if (depth === 1) {
            node.side = extra(el, 'side', 'direction') === 'left' ? 'left' : 'right';
            const color = Number.parseInt(extra(el, 'color'), 10);
            node.color = Number.isInteger(color) && color >= 0 ? color : i;
        }
        node.children = kids(el, 'outline').map((c, j) => convert(c, depth + 1, j));
        if (!node.children.length) delete node.folded;
        return node;
    };
    const body = kids(opml, 'body')[0];
    if (!body) throw new Error('OPML 缺少 body');
    const tops = kids(body, 'outline');
    const headTitle = kids(opml, 'head')[0]?.getElementsByTagName('title')[0]?.textContent.trim();
    const fallback = headTitle || filename.replace(/\.[^.]+$/, '') || '导入的导图';
    let root;
    if (tops.length === 1) {
        root = convert(tops[0], 0, 0);
    } else {
        root = createNode(fallback);
        root.children = tops.map((c, i) => convert(c, 1, i));
    }
    const map = createMap();
    map.root = root;
    return map;
}

// A deadline is "MM-DD" or "MM-DD HH:MM" at the very end of a node's title, e.g. "Ship it 11-20 23:00".
// The date may also be written "MM.DD", e.g. "Ship it 11.20 23:00".
// Returns { index, month, day, hour, minute, timed } or null; index is where the date starts in text.
const DUE_RE = /(^|\s)(\d{2})[-.](\d{2})(?: (\d{2}):(\d{2}))?$/;

export function parseDue(text) {
    const m = DUE_RE.exec(text);
    if (!m) return null;
    const [month, day] = [+m[2], +m[3]];
    const timed = m[4] !== undefined;
    const [hour, minute] = timed ? [+m[4], +m[5]] : [0, 0];
    // 02-29 is allowed since some year has it; the year is picked later.
    if (month < 1 || month > 12 || day < 1 || day > new Date(2024, month, 0).getDate()) return null;
    if (hour > 23 || minute > 59) return null;
    return { index: m.index + m[1].length, month, day, hour, minute, timed };
}

const DAY = 864e5;
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());

// Dates carry no year, so the closest occurrence to now wins (within about half a year either way).
export function dueDate(due, now = new Date()) {
    let best = null;
    for (const y of [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1]) {
        const d = new Date(y, due.month - 1, due.day, due.hour, due.minute);
        if (d.getMonth() !== due.month - 1) continue;   // 02-29 in a non-leap year
        if (!best || Math.abs(d - now) < Math.abs(best - now)) best = d;
    }
    return best;
}

// Weeks start on Monday. Monday = 0 … Sunday = 6.
const weekday = d => (d.getDay() + 6) % 7;
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const pad2 = n => String(n).padStart(2, '0');

// Quick dates typed at the end of a title, turned into a real "MM.DD" when the title is saved:
// "today", "tmr" (or "tomorrow"), a weekday "mon" … "sun", or "next mon" … "next sun",
// optionally followed by a time ("tmr 9:30"). A plain weekday is this week's, or next week's
// if it has already gone by; "next" always means next week (Monday to Sunday).
const QUICK_DUE_RE = /(^|\s)(today|tmr|tomorrow|(?:next\s+)?(?:mon|tue|wed|thu|fri|sat|sun))(?:\s+(\d{1,2}):(\d{2}))?$/i;

// A time on its own at the end ("23:32", "9:30") means today at that time. After a written date
// ("11.22 9:30") the date is kept and only the time is tidied up to "09:30".
const QUICK_TIME_RE = /(^|\s)(?:(\d{2}[-.]\d{2})\s+)?(\d{1,2}):(\d{2})$/;

export function expandQuickDue(text, now = new Date()) {
    const m = QUICK_DUE_RE.exec(text);
    if (!m) return expandQuickTime(text, now);
    const word = m[2].toLowerCase();
    let offset;
    if (word === 'today') offset = 0;
    else if (word === 'tmr' || word === 'tomorrow') offset = 1;
    else {
        const next = word.startsWith('next');
        offset = WEEKDAYS.indexOf(word.slice(-3)) - weekday(now);
        if (next) offset += 7;
        else if (offset < 0) offset += 7;
    }
    let time = '';
    if (m[3] !== undefined) {
        const [hour, minute] = [+m[3], +m[4]];
        if (hour > 23 || minute > 59) return text;
        time = ` ${pad2(hour)}:${pad2(minute)}`;
    }
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    return `${text.slice(0, m.index + m[1].length)}${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}${time}`;
}

function expandQuickTime(text, now) {
    const m = QUICK_TIME_RE.exec(text);
    if (!m) return text;
    const [hour, minute] = [+m[3], +m[4]];
    if (hour > 23 || minute > 59) return text;
    const date = m[2] ?? `${pad2(now.getMonth() + 1)}.${pad2(now.getDate())}`;
    const result = `${text.slice(0, m.index + m[1].length)}${date} ${pad2(hour)}:${pad2(minute)}`;
    // Leave it alone if the date part is not a real date (e.g. "13.45 10:00").
    return parseDue(result) ? result : text;
}

// A friendlier name for a date near now: 昨天 / 今天 / 明天, or a weekday last week ("上周五"),
// this week ("周三"), next week ("下周一") or the week after ("下下周二").
// Other dates return null and show as "MM.DD".
export function dueDayLabel(date, now = new Date()) {
    const diff = Math.round((startOfDay(date) - startOfDay(now)) / DAY);
    const names = { '-1': '昨天', 0: '今天', 1: '明天' };
    if (names[diff]) return names[diff];
    const name = '一二三四五六日'[weekday(date)];
    const week = Math.floor((weekday(now) + diff) / 7);
    const prefix = { '-1': '上', 0: '', 1: '下', 2: '下下' }[week];
    return prefix === undefined ? null : `${prefix}周${name}`;
}

// How urgent a deadline is: { state: 'overdue' | 'today' | 'upcoming', days }.
// days counts whole days late (overdue) or calendar days ahead (upcoming); hours is how
// long a timed deadline has been overdue.
// A date without time is due all day. A timed one is overdue the moment its time passes.
export function dueStatus(due, now = new Date()) {
    const date = dueDate(due, now);
    const ahead = Math.round((startOfDay(date) - startOfDay(now)) / DAY);
    if (due.timed && date <= now) {
        return { state: 'overdue', days: Math.floor((now - date) / DAY), hours: Math.floor((now - date) / 36e5) };
    }
    if (ahead < 0) return { state: 'overdue', days: -ahead };
    return ahead === 0 ? { state: 'today', days: 0 } : { state: 'upcoming', days: ahead };
}

// A title starting with ">", ">>" or ">>>" (or more ">") is being worked on right now with
// increasing highlight strength (levels 1..3), e.g. "> Write the report".
// Avoid matching comparison operators like ">= 10" or ">>= 1", while still allowing ">=== wait".
const RUN_RE = /^(>+)(?!>|=(?!==))\s*/;

// Returns the length of the leading ">" marker (including the spaces after it), or 0.
export function runPrefix(text) {
    return RUN_RE.exec(text)?.[0].length ?? 0;
}

// Highlight level for a leading ">" marker: 0 (none), 1 (">"), 2 (">>"), or 3 (">>>"+).
export function runLevel(text) {
    const m = RUN_RE.exec(text);
    return m ? Math.min(3, m[1].length) : 0;
}

// A title starting with "===" (or more "=") means we are waiting on something, e.g. "=== QA testing".
// It may follow a ">" / ">>" / ">>>" marker. Returns the length of both markers (including spaces), or 0.
export function waitPrefix(text) {
    const run = runPrefix(text);
    const wait = /^={3,}\s*/.exec(text.slice(run))?.[0].length ?? 0;
    return wait && run + wait;
}

// When a title is saved: a new "===" starts the clock, an existing one keeps its start time,
// and removing it clears the clock. Returns the waitSince to store, or undefined.
export function nextWaitSince(text, previous, now = Date.now()) {
    if (!waitPrefix(text)) return undefined;
    return Number.isFinite(previous) ? previous : now;
}

// Compact wait for the badge: "<1m", "<10m", then rounded down to 10 minutes ("10m", "1h",
// "1h10m"), with days in front once past a day ("1d1h10m").
export function waitShort(ms) {
    const minutes = Math.max(0, Math.floor(ms / 6e4));
    if (minutes < 1) return '<1m';
    if (minutes < 10) return '<10m';
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor(minutes / 60) % 24;
    const tens = Math.floor((minutes % 60) / 10) * 10;
    return (days ? `${days}d` : '') + (hours ? `${hours}h` : '') + (tens ? `${tens}m` : '');
}

// How long we have been waiting, in words: "不到 1 分钟", "25 分钟", "3 小时 20 分钟",
// "2 天 5 小时", "12 天", "3 个月".
export function waitDuration(ms) {
    const minutes = Math.max(0, Math.floor(ms / 6e4));
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const both = (a, ua, b, ub) => (b ? `${a} ${ua} ${b} ${ub}` : `${a} ${ua}`);
    if (minutes < 1) return '不到 1 分钟';
    if (hours < 1) return `${minutes} 分钟`;
    if (days < 1) return both(hours, '小时', minutes % 60, '分钟');
    if (days < 7) return both(days, '天', hours % 24, '小时');
    if (days < 60) return `${days} 天`;
    return `${Math.floor(days / 30)} 个月`;
}

const TOMBSTONE_TTL = 90 * 864e5;

function cleanDeletedMaps(raw, now) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [id, ts] of Object.entries(raw)) {
        const n = Number(ts);
        if (typeof id === 'string' && id && Number.isFinite(n) && now - n < TOMBSTONE_TTL) {
            out[id] = n;
        }
    }
    return out;
}

function canonicalMindPayload(maps, deletedMaps) {
    const sortedMaps = [...maps]
        .sort((a, b) => ((b.updated || b.created || 0) - (a.updated || a.created || 0)) || a.id.localeCompare(b.id));
    const sortedDeleted = {};
    for (const id of Object.keys(deletedMaps).sort()) {
        sortedDeleted[id] = deletedMaps[id];
    }
    return { version: 1, maps: sortedMaps, deletedMaps: sortedDeleted };
}

/**
 * Pure two-way merge for MyMind cloud sync.
 * - Supports tombstones (`deletedMaps`) so deletions propagate cleanly.
 * - Drops untouched default sample maps when the other side has real maps.
 * - Preserves offline dual-edit conflicts as a separate conflict copy instead of losing edits.
 */
export function mergeMindStates(local, remote, { baseUpdated = {}, now = Date.now() } = {}) {
    let localMaps = Array.isArray(local?.maps) ? local.maps.filter(isValidMap) : [];
    let remoteMaps = Array.isArray(remote?.maps) ? remote.maps.filter(isValidMap) : [];
    const localDel = cleanDeletedMaps(local?.deletedMaps, now);
    const remoteDel = cleanDeletedMaps(remote?.deletedMaps, now);

    const localOnlySample = localMaps.length === 1 && localMaps[0].isSample;
    const remoteOnlySample = remoteMaps.length === 1 && remoteMaps[0].isSample;
    const remoteHasReal = remoteMaps.some(m => !m.isSample);
    const localHasReal = localMaps.some(m => !m.isSample);

    if (localOnlySample && remoteHasReal) localMaps = [];
    if (remoteOnlySample && localHasReal) remoteMaps = [];

    const deletedMaps = { ...localDel };
    for (const [id, ts] of Object.entries(remoteDel)) {
        deletedMaps[id] = Math.max(deletedMaps[id] || 0, ts);
    }

    const localById = new Map(localMaps.map(m => [m.id, m]));
    const remoteById = new Map(remoteMaps.map(m => [m.id, m]));
    const allIds = new Set([...localById.keys(), ...remoteById.keys()]);
    const mergedMaps = [];
    let conflictCount = 0;

    const stamp = m => Number(m.updated || m.created || 0);
    const cloneMap = m => JSON.parse(JSON.stringify(m));

    for (const id of allIds) {
        const lm = localById.get(id);
        const rm = remoteById.get(id);
        const delTs = deletedMaps[id] || 0;

        if (lm && !rm) {
            if (delTs >= stamp(lm)) continue;
            if (delTs) delete deletedMaps[id];
            mergedMaps.push(cloneMap(lm));
        } else if (rm && !lm) {
            if (delTs >= stamp(rm)) continue;
            if (delTs) delete deletedMaps[id];
            mergedMaps.push(cloneMap(rm));
        } else if (lm && rm) {
            const lt = stamp(lm);
            const rt = stamp(rm);
            const maxT = Math.max(lt, rt);
            if (delTs >= maxT) continue;
            if (delTs) delete deletedMaps[id];

            const sameTree = JSON.stringify(lm.root) === JSON.stringify(rm.root);
            if (sameTree) {
                mergedMaps.push(cloneMap(lt >= rt ? lm : rm));
            } else {
                const baseT = Number(baseUpdated?.[id]) || 0;
                const dualEdited = baseT > 0 && lt > baseT && rt > baseT;
                const winner = lt >= rt ? lm : rm;
                const loser = lt >= rt ? rm : lm;
                mergedMaps.push(cloneMap(winner));
                if (dualEdited) {
                    const copy = cloneMap(loser);
                    copy.id = uid();
                    delete copy.isSample;
                    copy.root.text = `${copy.root.text || '未命名导图'} (同步冲突副本)`;
                    copy.updated = now;
                    mergedMaps.push(copy);
                    conflictCount++;
                }
            }
        }
    }

    const merged = canonicalMindPayload(mergedMaps, deletedMaps);
    const origLocal = canonicalMindPayload(
        Array.isArray(local?.maps) ? local.maps.filter(isValidMap) : [],
        localDel
    );
    const origRemote = canonicalMindPayload(
        Array.isArray(remote?.maps) ? remote.maps.filter(isValidMap) : [],
        remoteDel
    );

    const mergedStr = JSON.stringify(merged);
    const localChanged = mergedStr !== JSON.stringify(origLocal);
    const remoteChanged = mergedStr !== JSON.stringify(origRemote);

    const nextBaseUpdated = {};
    for (const m of merged.maps) nextBaseUpdated[m.id] = stamp(m);

    return {
        merged,
        localChanged,
        remoteChanged,
        conflictCount,
        metaExtra: { baseUpdated: nextBaseUpdated },
    };
}
