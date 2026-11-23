import {
    PALETTE_SIZE, buildIndex, cloneNode, compareVersions, computeLayout, countNodes, createMap, createNode,
    dueDate, dueDayLabel, dueStatus, expandQuickDue, exportOPML, importOPML, isValidMap, isValidNode, mergeMindStates, nextColor, nextWaitSince, nodesToPlainText, parseDue, sampleMap, subtreeIds,
    runPrefix, visibleChildren, waitDuration, waitPrefix, waitShort,
} from './model.js';
import { createCloudSync, formatSyncTime } from '../shared/cloud-sync.js';

// Release changelog (newest first). Prepend a new entry on each user-facing update;
// clients with an older stored version will see a one-line update toast on startup.
const RELEASES = [
    { version: '1.1.0', note: '支持单选与多选节点的复制、剪切与粘贴为子节点' },
    { version: '1.0.0', note: '支持定期自动云同步与唤醒恢复' },
];
const APP_VERSION = RELEASES[0].version;

const STORE = 'mymind.v1';
const FOCUS_STORE = 'mymind.focus';
const CLIPBOARD_STORE = 'mymind.clipboard';
const VERSION_STORE = 'mymind.version';

// One-time migration from the old MyMindC keys so existing maps survive the rename.
try {
    for (const [from, to] of [['mymindc.v1', STORE], ['mymindc.focus', FOCUS_STORE]]) {
        const legacy = localStorage.getItem(from);
        if (legacy !== null && localStorage.getItem(to) === null) localStorage.setItem(to, legacy);
        if (legacy !== null) localStorage.removeItem(from);
    }
} catch { /* storage unavailable */ }

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;
const MARGIN = 14;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = isMac ? '⌘' : 'Ctrl ';
const supportsPlaintext = (() => {
    const el = document.createElement('div');
    el.contentEditable = 'plaintext-only';
    return el.contentEditable === 'plaintext-only';
})();

const $ = id => document.getElementById(id);
const canvas = $('canvas');
const world = $('world');
const links = $('links');
const nodesEl = $('nodes');
const dropLine = $('drop-line');
const marquee = $('marquee');
const nodeBar = $('node-bar');
const sidebar = $('sidebar');
const fileList = $('file-list');
const notePanel = $('note-panel');
const noteText = $('note-text');
const helpPanel = $('help');
const fileInput = $('file-input');

let state = { maps: [], activeId: null, deletedMaps: {} };
let index = new Map();
let running = new Set();        // ids of ">>>" nodes and everything under them
let positions = new Map();
let selectedId = null;          // primary (focused) node
let selection = new Set();      // all selected nodes, always includes selectedId
let editing = null;
let drag = null;
let view = { x: 0, y: 0, z: 1 };
let selectMode = false;
const checked = new Set();
const histories = new Map();
let clipboard = null;           // copied node subtrees (snapshot), synced across tabs
let lastClipboardKeyAt = 0;
let noteSession = null;
let noteFor = null;
// 'off', 'focus' (dim everything off the selection's path) or 'fade' (older selection
// paths fade out gradually). Stored as '0' / '1' / 'fade' so old '1' values still mean focus.
let viewMode = { 1: 'focus', fade: 'fade' }[localStorage.getItem(FOCUS_STORE)] ?? 'off';
const FADE_STEPS = 10;          // current selection + 9 previous ones
let fadeTrail = [];             // recent selections (current one first), each an array of ids

const activeMap = () => state.maps.find(m => m.id === state.activeId);
const nodeEl = id => nodesEl.querySelector(`.node[data-id="${CSS.escape(id)}"]`);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sideOf = node => (node.side === 'left' ? 'left' : 'right');
const walk = (node, fn) => { fn(node); node.children.forEach(c => walk(c, fn)); };

/* ---------- Storage ---------- */

let saveTimer = null;

function load() {
    try {
        const data = JSON.parse(localStorage.getItem(STORE) || 'null');
        if (data && Array.isArray(data.maps)) {
            state.maps = data.maps.filter(isValidMap);
            state.activeId = data.activeId;
            state.deletedMaps = (data.deletedMaps && typeof data.deletedMaps === 'object') ? data.deletedMaps : {};
        }
    } catch {
        toast('读取本地数据失败');
    }
    if (!state.maps.length) {
        const map = sampleMap();
        state.maps = [map];
        state.activeId = map.id;
        saveNow();
    }
    if (!activeMap()) state.activeId = state.maps[0].id;
    loadClipboard();
}

function loadClipboard() {
    try {
        const data = JSON.parse(localStorage.getItem(CLIPBOARD_STORE) || 'null');
        if (Array.isArray(data) && data.length && data.every(isValidNode)) clipboard = data;
    } catch { /* clipboard storage unavailable or malformed */ }
}

function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 250);
}

function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
        localStorage.setItem(STORE, JSON.stringify(state));
    } catch {
        toast('保存失败：浏览器存储空间不足，请导出 OPML 备份');
    }
}

window.addEventListener('pagehide', () => { if (saveTimer) saveNow(); });
window.addEventListener('storage', event => {
    if (event.key === CLIPBOARD_STORE) {
        try {
            const data = JSON.parse(event.newValue || 'null');
            clipboard = Array.isArray(data) && data.length && data.every(isValidNode) ? data : null;
            updateNodeBar();
        } catch { /* ignore malformed clipboard writes */ }
        return;
    }
    if (event.key !== STORE || !event.newValue) return;
    try {
        const data = JSON.parse(event.newValue);
        if (!Array.isArray(data.maps)) return;
        if (editing) finishEdit(false);
        const keep = state.activeId;
        state.maps = data.maps.filter(isValidMap);
        state.deletedMaps = (data.deletedMaps && typeof data.deletedMaps === 'object') ? data.deletedMaps : {};
        if (!state.maps.length) state.maps = [createMap()];
        state.activeId = state.maps.some(m => m.id === keep) ? keep : state.maps[0].id;
        render();
    } catch { /* ignore malformed writes from elsewhere */ }
});

/* ---------- History ---------- */

function history() {
    if (!histories.has(state.activeId)) histories.set(state.activeId, { undo: [], redo: [] });
    return histories.get(state.activeId);
}

function snapshot() {
    return { root: JSON.stringify(activeMap().root), sel: selectedId };
}

function pushUndo(snap) {
    const h = history();
    h.undo.push(snap);
    if (h.undo.length > 200) h.undo.shift();
    h.redo.length = 0;
}

function touched() {
    const map = activeMap();
    map.updated = Date.now();
    delete map.isSample;
    scheduleSave();
    sync.markDirty();
}

// Run a structural change; records undo only if the tree actually changed.
function commit(mutate) {
    if (editing) finishEdit(true);
    const snap = snapshot();
    if (mutate(activeMap().root) === false) return false;
    if (JSON.stringify(activeMap().root) === snap.root) {
        render();
        return false;
    }
    pushUndo(snap);
    touched();
    render();
    return true;
}

function restore(from, to) {
    if (editing) finishEdit(true);
    const h = history();
    const snap = h[from].pop();
    if (!snap) return;
    h[to].push(snapshot());
    activeMap().root = JSON.parse(snap.root);
    setSelection(snap.sel ? [snap.sel] : [], snap.sel);
    touched();
    render();
    if (selectedId) ensureVisible(selectedId);
}
const undo = () => restore('undo', 'redo');
const redo = () => restore('redo', 'undo');

/* ---------- Rendering ---------- */

function icon(name) {
    return `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

function controlButton(act, label, html) {
    const b = document.createElement('button');
    b.className = act;
    b.dataset.act = act;
    b.tabIndex = -1;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = html;
    return b;
}

function controls(node, side, isRoot) {
    const ctl = document.createElement('div');
    ctl.className = 'ctl';
    ctl.dataset.side = side;
    if (!isRoot && node.children.length) {
        const label = node.folded ? `展开 ${countNodes(node) - 1} 个子节点` : '折叠子节点';
        ctl.append(controlButton('fold', label, `${icon('chevron')}<span class="count">${countNodes(node) - 1}</span>`));
    }
    const add = controlButton('add', isRoot && side === 'left' ? '在左侧新建分支' : '新建子节点', icon('plus'));
    add.dataset.side = side;
    ctl.append(add);
    return ctl;
}

// Nodes are created already dimmed when needed, so a re-render never flashes them
// bright and then fades them back out.
function buildNode({ node, depth, side, color }, levels = shadeLevels()) {
    const el = document.createElement('div');
    el.className = `node d${Math.min(depth, 2)}`;
    el.dataset.id = node.id;
    el.dataset.side = side;
    el.style.setProperty('--c', `var(--b${color % PALETTE_SIZE})`);
    el.classList.toggle('folded', Boolean(node.folded && node.children.length));
    el.classList.toggle('running', running.has(node.id));
    if (node.task) {
        const box = controlButton('check', node.task === 'done' ? '标记为未完成' : '标记为完成', icon(node.task === 'done' ? 'circle-check' : 'circle'));
        el.append(box);
        el.classList.toggle('done', node.task === 'done');
    }
    const text = document.createElement('span');
    text.className = 'text';
    fillText(text, node);
    el.append(text);
    if (node.note) {
        const mark = controlButton('note-mark', '查看备注', icon('note'));
        mark.dataset.act = 'note';
        mark.title = node.note.length > 160 ? node.note.slice(0, 160) + '…' : node.note;
        el.append(mark);
    }
    if (depth === 0) el.append(controls(node, 'left', true), controls(node, 'right', true));
    else el.append(controls(node, side, false));
    if (selection.has(node.id)) el.classList.add('selected');
    shade(el, levels);
    return el;
}

// A leading ">>>" becomes a running badge, a leading "===" (after it, if both) a waiting badge,
// and a trailing "MM-DD" / "MM.DD" (optionally + " HH:MM") a deadline badge.
function fillText(el, node) {
    const done = node.task === 'done';
    const parts = [];
    let value = node.text;
    const run = runPrefix(value);
    if (run) {
        parts.push(runBadge(done));
        value = value.slice(run);
    }
    const wait = waitPrefix(value);
    if (wait) {
        parts.push(waitBadge(node.waitSince, done));
        value = value.slice(wait);
    }
    const due = parseDue(value);
    if (due) {
        const badge = document.createElement('span');
        badge.className = 'due';
        badge.due = due;
        badge.done = done;
        paintDue(badge);
        parts.push(value.slice(0, due.index).trimEnd(), badge);
    } else {
        parts.push(value);
    }
    el.replaceChildren(...parts);
}

// A plump hourglass, drawn inline so the sand can move. At rest all the sand is at the bottom.
// The top and bottom sand are mirror images, so the glass turned over looks like a full top.
const HOURGLASS = `<svg class="hourglass" viewBox="0 0 24 24" aria-hidden="true">
    <path class="glass" d="M4 3h16M4 21h16M5.4 3c0 5.4 5.4 6.6 5.4 9s-5.4 3.6-5.4 9h13.2c0-5.4-5.4-6.6-5.4-9s5.4-3.6 5.4-9z"/>
    <path class="sand top" d="M17.1 5.2H6.9c.6 2.7 3 4.5 5.1 5.7 2.1-1.2 4.5-3 5.1-5.7z"/>
    <path class="sand bottom" d="M6.9 18.8h10.2c-.6-2.7-3-4.5-5.1-5.7-2.1 1.2-4.5 3-5.1 5.7z"/>
    <path class="sand stream" d="M11.55 11h.9v7h-.9z"/>
</svg>`;

// Turn the hourglass over once, e.g. when the waiting time moves on to the next step.
function flipHourglass(badge) {
    const glass = badge.querySelector('.hourglass');
    glass.classList.remove('flip');
    void glass.getBoundingClientRect();   // restart the animation if it is still running
    glass.classList.add('flip');
}

function runBadge(done) {
    const badge = document.createElement('span');
    badge.className = 'run';
    badge.textContent = '>>>';
    badge.title = done ? '已完成' : '执行中：这个节点和它的子节点始终高亮';
    return badge;
}

function waitBadge(since, done) {
    const badge = document.createElement('span');
    badge.className = 'wait';
    badge.innerHTML = `${HOURGLASS}<span class="wait-label"></span>`;
    badge.since = since;
    badge.done = done;
    paintWait(badge);
    return badge;
}

// The badge warms from calm blue to amber between one and seven days of waiting, as a nudge
// to chase it up. Returns true when the label changed (so the layout may need updating).
function paintWait(badge, now = Date.now()) {
    const label = badge.lastChild;
    const before = label.textContent;
    if (!Number.isFinite(badge.since)) {
        label.textContent = '等待中';
        badge.title = '等待中';
    } else {
        const span = waitDuration(now - badge.since);
        const start = new Date(badge.since);
        const pad = n => String(n).padStart(2, '0');
        const when = `${start.getMonth() + 1}月${start.getDate()}日 ${pad(start.getHours())}:${pad(start.getMinutes())}`;
        label.textContent = waitShort(now - badge.since);
        badge.title = `${badge.done ? '已完成，' : ''}已等待 ${span}\n从 ${when} 开始`;
        const days = (now - badge.since) / 864e5;
        badge.style.setProperty('--wait-mix', `${Math.round(clamp01((days - 1) / 6) * 100)}%`);
    }
    const changed = label.textContent !== before;
    if (changed && before && !badge.done) flipHourglass(badge);
    return changed;
}

const clamp01 = x => Math.min(1, Math.max(0, x));

// Overdue is red, today amber, the next 3 days yellow. Deadlines fade towards grey the
// longer they are overdue (from a week to a month) or the further away they are (3 to 14 days).
// Completed tasks always get the grey badge.
// Dates in this week or next read as 今天 / 明天 / 周三 / 下周一 (plus any time); others keep
// "MM.DD", however they were typed. Returns true when the text changed (so the layout may need updating).
function paintDue(badge, now = new Date()) {
    const { state, days, hours } = dueStatus(badge.due, now);
    const date = dueDate(badge.due, now);
    const label = dueDayLabel(date, now);
    const pad = n => String(n).padStart(2, '0');
    const time = badge.due.timed ? ` ${pad(badge.due.hour)}:${pad(badge.due.minute)}` : '';
    const before = badge.textContent;
    const md = `${pad(badge.due.month)}.${pad(badge.due.day)}`;
    badge.textContent = (label ?? md) + time;
    const exact = `${md} 周${'日一二三四五六'[date.getDay()]}${time}`;
    let strength = 1;
    if (state === 'overdue') strength = 1 - 0.85 * clamp01((days - 7) / 23);
    else if (state === 'upcoming') strength = 1 - clamp01((days - 3) / 11);
    if (badge.done) strength = 0;
    badge.dataset.state = state;
    badge.classList.toggle('pale', strength < 0.7);
    badge.style.setProperty('--due-mix', `${Math.round(strength * 100)}%`);
    const status = badge.done ? '已完成' : state === 'today' ? '今天到期' : state === 'overdue' ? (days ? `已过期 ${days} 天` : hours ? `已过期 ${hours} 小时` : '刚刚过期') : `还有 ${days} 天`;
    badge.title = `${exact} · ${status}`;
    return badge.textContent !== before;
}

// Re-paint every minute so deadlines and waiting times move on without a re-render.
setInterval(() => {
    const now = new Date();
    let grew = false;
    for (const badge of nodesEl.querySelectorAll('.due')) grew = paintDue(badge, now) || grew;
    for (const badge of nodesEl.querySelectorAll('.wait')) grew = paintWait(badge, now.getTime()) || grew;
    if (grew) relayout();
}, 60e3);

function render() {
    if (drag?.kind === 'node') cancelDrag();
    const map = activeMap();
    index = buildIndex(map.root);
    running = new Set();
    for (const { node } of index.values()) if (runPrefix(node.text)) subtreeIds(node, running);
    const kept = [...selection].filter(id => index.has(id));
    setSelection(kept, index.has(selectedId) ? selectedId : kept.at(-1) ?? null, false);
    const fragment = document.createDocumentFragment();
    const levels = shadeLevels();
    for (const info of index.values()) fragment.append(buildNode(info, levels));
    nodesEl.replaceChildren(fragment);
    relayout();
    renderChrome();
}

function relayout() {
    const sizes = new Map();
    for (const el of nodesEl.children) sizes.set(el.dataset.id, { w: el.offsetWidth, h: el.offsetHeight });
    positions = computeLayout(activeMap().root, sizes);
    for (const el of nodesEl.children) {
        const p = positions.get(el.dataset.id);
        el.style.transform = `translate(${p.x}px, ${p.y}px)`;
    }
    drawLinks();
    applyFocus();
    positionNote();
}

// A selection's path is the selected nodes, their ancestors and all their descendants.
function addPath(ids, into, level) {
    for (const id of ids) {
        const info = index.get(id);
        if (!info) continue;
        for (let p = info.parent; p; p = index.get(p.id).parent) if (!into.has(p.id)) into.set(p.id, level);
        for (const sub of subtreeIds(info.node)) if (!into.has(sub)) into.set(sub, level);
    }
}

// Map of id -> level (0 = current selection's path, 1 = previous selection's path, ...),
// or null when nothing should be shaded. Ids missing from the map are fully dimmed.
// With nothing selected, focus mode dims every node and fade mode keeps showing the
// trail as it was, with the last selection's path still at full strength.
function shadeLevels() {
    if (viewMode === 'off' || drag?.kind === 'marquee') return null;
    const levels = new Map();
    addPath(selection, levels, 0);
    if (viewMode === 'fade') fadeTrail.forEach((ids, i) => addPath(ids, levels, i));
    return levels;
}

// Level 0 is full strength; levels 1..8 step from 90% colour / no dimming down to
// 0% colour / full dimming, the same look as a dimmed node in focus mode.
// Running (">>>") subtrees always stay at full strength.
function shade(el, levels) {
    const level = levels && !running.has(el.dataset.id) ? levels.get(el.dataset.id) ?? FADE_STEPS : 0;
    const t = (level - 1) / (FADE_STEPS - 2);
    const faded = level > 0 && t < 1;
    el.classList.toggle('dimmed', t >= 1);
    el.classList.toggle('faded', faded);
    if (faded) {
        el.style.setProperty('--fade-gray', (0.1 + 0.9 * t).toFixed(3));
        el.style.setProperty('--fade-opacity', (1 - 0.78 * t).toFixed(3));
    }
}

function applyFocus(levels = shadeLevels()) {
    for (const el of nodesEl.children) shade(el, levels);
    for (const el of links.children) shade(el, levels);
}

// Move the current selection to the front of the trail. Deselecting leaves the trail
// alone, so every remembered path keeps its level until a new selection is made.
function recordTrail() {
    if (!selection.size) return;
    const key = ids => [...ids].sort().join('\n');
    const now = key(selection);
    fadeTrail = [[...selection], ...fadeTrail.filter(ids => key(ids) !== now)].slice(0, FADE_STEPS);
}

function setViewMode(mode) {
    viewMode = viewMode === mode ? 'off' : mode;
    try { localStorage.setItem(FOCUS_STORE, { off: '0', focus: '1', fade: 'fade' }[viewMode]); } catch { /* not critical */ }
    syncViewButtons();
    applyFocus();
    toast({ off: '已关闭专注模式', focus: '专注模式已开启', fade: '渐隐模式已开启' }[viewMode], 1200);
}

function syncViewButtons() {
    document.querySelector('[data-cmd="focus"]').setAttribute('aria-pressed', String(viewMode === 'focus'));
    document.querySelector('[data-cmd="fade"]').setAttribute('aria-pressed', String(viewMode === 'fade'));
}

function drawLinks() {
    const ns = 'http://www.w3.org/2000/svg';
    const fragment = document.createDocumentFragment();
    const levels = shadeLevels();
    const stroke = (el, color, width) => {
        el.style.stroke = `var(--b${color % PALETTE_SIZE})`;
        el.style.strokeWidth = width;
        shade(el, levels);
        return el;
    };
    for (const [id, info] of index) {
        const p = positions.get(id);
        const right = info.side === 'right';
        if (info.node.folded && info.node.children.length && info.parent) {
            // A short stub with a dot marks hidden children; the controls themselves stay hidden.
            const x = right ? p.x + p.w : p.x;
            const y = p.y + p.h;
            const stub = document.createElementNS(ns, 'path');
            stub.dataset.id = id;
            stub.setAttribute('d', `M${x},${y} H${x + (right ? 8 : -8)}`);
            fragment.append(stroke(stub, info.color, '2'));
            const dot = document.createElementNS(ns, 'circle');
            dot.classList.add('fold-dot');
            dot.dataset.id = id;
            dot.setAttribute('cx', x + (right ? 12 : -12));
            dot.setAttribute('cy', y);
            dot.setAttribute('r', '4');
            fragment.append(stroke(dot, info.color, '2'));
        }
        if (!info.parent) continue;
        const pp = positions.get(info.parent.id);
        const sx = right ? pp.x + pp.w : pp.x;
        const sy = info.depth === 1 ? pp.y + pp.h / 2 : pp.y + pp.h;
        const ex = right ? p.x : p.x + p.w;
        const ey = p.y + p.h;
        const fx = right ? p.x + p.w : p.x;
        const dx = ex - sx;
        const path = document.createElementNS(ns, 'path');
        path.dataset.id = id;
        path.setAttribute('d', `M${sx},${sy} C${sx + dx * 0.55},${sy} ${ex - dx * 0.55},${ey} ${ex},${ey} L${fx},${ey}`);
        fragment.append(stroke(path, info.color, info.depth === 1 ? '3' : '2'));
    }
    links.replaceChildren(fragment);
}

function renderChrome() {
    const map = activeMap();
    const title = map.root.text.trim() || '未命名导图';
    $('map-title').textContent = title;
    document.title = `${title} · MyMind`;
    updateHistoryButtons();
    updateNodeBar();
    syncNote();
    if (!sidebar.hidden) renderSidebar();
}

function updateHistoryButtons() {
    const h = history();
    document.querySelector('[data-cmd="undo"]').disabled = !h.undo.length;
    document.querySelector('[data-cmd="redo"]').disabled = !h.redo.length;
}

function updateNodeBar() {
    const info = selectedId && index.get(selectedId);
    nodeBar.hidden = !info || Boolean(drag?.started || drag?.moved);
    if (!info) return;
    const multi = selection.size > 1;
    nodeBar.classList.toggle('multi', multi);
    $('multi-count').textContent = `已选 ${selection.size} 个节点`;
    nodeBar.querySelector('[data-cmd="sibling"]').disabled = !info.parent;
    nodeBar.querySelector('[data-cmd="paste"]').disabled = !hasClipboard();
    nodeBar.querySelector('[data-cmd="delete"]').disabled = ![...selection].some(id => index.get(id)?.parent);
    nodeBar.querySelector('[data-cmd="task"]').setAttribute('aria-pressed', String(Boolean(info.node.task)));
    nodeBar.querySelector('[data-cmd="note"]').setAttribute('aria-pressed', String(!notePanel.hidden));
}

function setSelection(ids, primary = ids.at(-1) ?? null, paint = true) {
    selection = new Set(ids);
    if (primary) selection.add(primary);
    selectedId = primary;
    if (!paint) return;
    if (drag?.kind !== 'marquee') recordTrail();
    for (const el of nodesEl.children) el.classList.toggle('selected', selection.has(el.dataset.id));
    applyFocus();
    updateNodeBar();
    syncNote();
}

const select = id => setSelection(id ? [id] : [], id);

/* ---------- View ---------- */

function applyView() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
    $('zoom-label').textContent = `${Math.round(view.z * 100)}%`;
    positionNote();
}

function zoomAt(z, cx = innerWidth / 2, cy = innerHeight / 2) {
    z = clamp(z, MIN_ZOOM, MAX_ZOOM);
    const wx = (cx - view.x) / view.z;
    const wy = (cy - view.y) / view.z;
    view = { z, x: cx - wx * z, y: cy - wy * z };
    applyView();
}

function bounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of positions.values()) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x + p.w); maxY = Math.max(maxY, p.y + p.h);
    }
    return { minX, minY, maxX, maxY };
}

function fit() {
    const b = bounds();
    const z = clamp(Math.min((innerWidth - 120) / (b.maxX - b.minX), (innerHeight - 170) / (b.maxY - b.minY), 1), MIN_ZOOM, 1);
    view = {
        z,
        x: innerWidth / 2 - ((b.minX + b.maxX) / 2) * z,
        y: innerHeight / 2 - ((b.minY + b.maxY) / 2) * z,
    };
    applyView();
}

function ensureVisible(id) {
    const p = positions.get(id);
    if (!p) return;
    const m = 70;
    const left = view.x + p.x * view.z;
    const top = view.y + p.y * view.z;
    const right = left + p.w * view.z;
    const bottom = top + p.h * view.z;
    let dx = 0, dy = 0;
    if (right > innerWidth - m) dx = innerWidth - m - right;
    if (left + dx < m) dx = m - left;
    if (bottom > innerHeight - m) dy = innerHeight - m - bottom;
    if (top + dy < m) dy = m - top;
    if (dx || dy) {
        view.x += dx;
        view.y += dy;
        applyView();
    }
}

canvas.addEventListener('wheel', event => {
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1;
    const dx = event.deltaX * unit;
    const dy = event.deltaY * unit;
    if (event.metaKey || event.ctrlKey) {
        // Trackpad pinch arrives as ctrl+wheel with small deltas; mouse wheels send large steps.
        const rate = event.ctrlKey && !event.metaKey ? 0.01 : 0.002;
        zoomAt(view.z * Math.exp(-(dy || dx) * rate), event.clientX, event.clientY);
        return;
    }
    if (event.shiftKey) view.x -= dx || dy;
    else {
        view.x -= dx;
        view.y -= dy;
    }
    applyView();
}, { passive: false });
for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, e => e.preventDefault());
// Safari can ignore viewport scale limits. Cancel native pinching while allowing single-finger scrolling.
document.addEventListener('touchmove', event => {
    if (event.touches.length > 1 && event.cancelable) event.preventDefault();
}, { passive: false });

/* ---------- Editing ---------- */

function placeCaret(el, selectAll) {
    const range = document.createRange();
    range.selectNodeContents(el);
    if (!selectAll) range.collapse(false);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
}

function startEdit(id, { created = false, replace = null } = {}) {
    if (editing) finishEdit(true);
    const el = nodeEl(id);
    if (!el) return;
    select(id);
    const text = el.querySelector('.text');
    editing = { id, el, text, created, original: index.get(id).node.text, snap: created ? null : snapshot() };
    // The edit box starts at the node's current width and grows from there.
    el.style.minWidth = `${el.offsetWidth}px`;
    el.classList.add('editing');
    text.contentEditable = supportsPlaintext ? 'plaintext-only' : 'true';
    text.spellcheck = false;
    // Edit the raw title, not the deadline badge.
    text.textContent = replace ?? editing.original;
    // Re-measure now that the node is editable, so the box and its branch line stay aligned.
    relayout();
    text.focus({ preventScroll: true });
    placeCaret(text, replace === null);
    ensureVisible(id);
}

function readText(el) {
    return (supportsPlaintext ? el.textContent : el.innerText).replace(/\r/g, '').replace(/^\n+|\n+$/g, '').replace(/^[ \t]+|[ \t]+$/g, '');
}

function finishEdit(save) {
    if (!editing) return;
    const { id, el, text, created, original, snap } = editing;
    editing = null;
    text.removeAttribute('contenteditable');
    el.classList.remove('editing');
    el.style.minWidth = '';
    const node = index.get(id)?.node;
    if (!node) return render();
    if (!save) {
        if (created) {
            // Cancelling a node that was just added removes it again.
            const s = history().undo.pop();
            if (s) {
                activeMap().root = JSON.parse(s.root);
                select(s.sel);
                touched();
            }
        } else {
            text.textContent = original;
        }
        render();
        return;
    }
    // A quick date typed at the end ("tmr", "next mon") is stored as a real date.
    const value = expandQuickDue(readText(text));
    if (value !== node.text || nextWaitSince(value, node.waitSince) !== node.waitSince) {
        if (!created) pushUndo(snap);
        setTitle(node, value);
        touched();
    }
    render();
}

// "===" starts a waiting clock; changing the rest of the title keeps it running.
function setTitle(node, value) {
    const waitSince = nextWaitSince(value, node.waitSince);
    node.text = value;
    if (waitSince === undefined) delete node.waitSince;
    else node.waitSince = waitSince;
}

nodesEl.addEventListener('input', event => {
    if (!editing || event.target !== editing.text) return;
    relayout();
    if (editing.id === activeMap().root.id) $('map-title').textContent = readText(editing.text) || '未命名导图';
});

nodesEl.addEventListener('keydown', event => {
    if (!editing || event.target !== editing.text) return;
    event.stopPropagation();
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && (event.shiftKey || event.altKey)) {
        if (!supportsPlaintext || event.altKey) {
            event.preventDefault();
            document.execCommand('insertText', false, '\n');
        }
        return;
    }
    if (event.key === 'Enter') {
        event.preventDefault();
        finishEdit(true);
    } else if (event.key === 'Escape') {
        event.preventDefault();
        finishEdit(false);
    } else if (event.key === 'Tab') {
        event.preventDefault();
        const id = editing.id;
        finishEdit(true);
        if (!event.shiftKey) addChild(id);
    }
});

nodesEl.addEventListener('paste', event => {
    if (!editing || !editing.text.contains(event.target)) return;
    event.preventDefault();
    document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
});

nodesEl.addEventListener('focusout', event => {
    if (editing && event.target === editing.text) finishEdit(true);
});

/* ---------- Node operations ---------- */

// New nodes under a to-do parent are to-dos too.
function insertNode(parent, node, at) {
    if (editing) finishEdit(true);
    const snap = snapshot();
    if (parent.task) node.task = 'open';
    delete parent.folded;
    parent.children.splice(at ?? parent.children.length, 0, node);
    pushUndo(snap);
    select(node.id);
    touched();
    render();
    startEdit(node.id, { created: true });
}

function addChild(id = selectedId, side = 'right') {
    if (editing) {
        const editingId = editing.id;
        finishEdit(true);
        id ??= editingId;
    }
    const info = id && index.get(id);
    if (!info) return;
    const node = createNode('');
    if (!info.parent) Object.assign(node, { side, color: nextColor(activeMap().root) });
    insertNode(info.node, node);
}

function addSibling(where = 'after') {
    if (editing) finishEdit(true);
    const info = selectedId && index.get(selectedId);
    if (!info) return;
    if (!info.parent) return addChild(info.node.id);
    const node = createNode('');
    if (info.depth === 1) Object.assign(node, { side: info.side, color: nextColor(activeMap().root) });
    const at = info.parent.children.indexOf(info.node) + (where === 'after' ? 1 : 0);
    insertNode(info.parent, node, at);
}

function sameSideSiblings(info) {
    const list = info.parent.children;
    return info.depth === 1 ? list.filter(c => sideOf(c) === info.side) : list;
}

function deleteSelected() {
    const targets = [...selection].map(id => index.get(id)).filter(info => info?.parent);
    if (!targets.length) {
        if (selection.size) toast('中心主题不能删除');
        return;
    }
    let next = null;
    if (targets.length === 1) {
        const [info] = targets;
        const siblings = sameSideSiblings(info);
        const i = siblings.indexOf(info.node);
        next = siblings[i + 1] ?? siblings[i - 1] ?? info.parent;
    } else {
        const removed = new Set(targets.map(t => t.node.id));
        let parent = targets[0].parent;
        while (parent && [...removed].some(id => subtreeIds(index.get(id).node).has(parent.id))) parent = index.get(parent.id).parent;
        next = parent ?? activeMap().root;
    }
    commit(() => {
        for (const { node, parent } of targets) {
            const i = parent.children.indexOf(node);
            if (i >= 0) parent.children.splice(i, 1);
        }
        select(next.id);
    });
}

function hasClipboard() {
    return Boolean(clipboard?.length);
}

// Top-level selected nodes in tree order; descendants covered by a selected ancestor are omitted.
function selectedRoots() {
    const roots = [];
    const covered = new Set();
    for (const [id, info] of index) {
        if (!selection.has(id) || covered.has(id)) continue;
        roots.push(info);
        subtreeIds(info.node, covered);
    }
    return roots;
}

function writeClipboard(nodes, clipboardData = null) {
    clipboard = nodes;
    try { localStorage.setItem(CLIPBOARD_STORE, JSON.stringify(nodes)); } catch { /* in-memory fallback */ }
    const plain = nodesToPlainText(nodes);
    if (clipboardData) {
        clipboardData.setData('text/plain', plain);
    } else {
        navigator.clipboard?.writeText?.(plain).catch(() => {});
    }
    updateNodeBar();
}

function snapshotSelected(roots) {
    return roots.map(({ node, depth, side }) => {
        const copy = cloneNode(node);
        if (depth === 1 && side === 'left') copy.side = 'left';
        return copy;
    });
}

function clipboardToast(verb, nodes) {
    const total = nodes.reduce((sum, n) => sum + countNodes(n), 0);
    if (nodes.length === 1) {
        toast(total > 1 ? `已${verb}节点（含 ${total - 1} 个子节点）` : `已${verb}节点`, 1600);
    } else {
        toast(total > nodes.length ? `已${verb} ${nodes.length} 个分支（共 ${total} 个节点）` : `已${verb} ${nodes.length} 个节点`, 1600);
    }
}

function copySelected(clipboardData = null) {
    if (editing || drag) return false;
    const roots = selectedRoots();
    if (!roots.length) return false;
    const copied = snapshotSelected(roots);
    writeClipboard(copied, clipboardData);
    clipboardToast('复制', copied);
    return true;
}

function cutSelected(clipboardData = null) {
    if (editing || drag || !selection.size) return false;
    if (selection.has(activeMap().root.id)) {
        toast('中心主题不能剪切');
        return false;
    }
    const roots = selectedRoots().filter(info => info.parent);
    if (!roots.length) return false;
    const copied = snapshotSelected(roots);
    writeClipboard(copied, clipboardData);
    deleteSelected();
    clipboardToast('剪切', copied);
    return true;
}

function pasteNodes(targetId = selectedId) {
    if (editing) finishEdit(true);
    if (drag || !hasClipboard()) return false;
    const info = targetId && index.get(targetId);
    if (!info) {
        toast('请先选择要粘贴到的目标节点', 1800);
        return false;
    }
    const root = activeMap().root;
    const target = info.node;
    const pasted = [];
    const ok = commit(() => {
        delete target.folded;
        for (const src of clipboard) {
            const copy = cloneNode(src);
            if (target === root) {
                copy.side = src.side === 'left' ? 'left' : 'right';
                copy.color = nextColor(root);
            }
            if (target.task) walk(copy, n => { n.task ??= 'open'; });
            target.children.push(copy);
            pasted.push(copy);
        }
    });
    if (!ok || !pasted.length) return false;
    setSelection(pasted.map(n => n.id), pasted[0].id);
    ensureVisible(pasted[0].id);
    clipboardToast('粘贴', pasted);
    return true;
}

// Turning a to-do on or off applies to the whole branch below it.
function toggleTask() {
    const infos = [...selection].map(id => index.get(id)).filter(Boolean);
    if (!infos.length) return;
    const on = !index.get(selectedId)?.node.task;
    commit(() => {
        for (const { node } of infos) {
            walk(node, n => {
                if (on) n.task ??= 'open';
                else n.task = null;
            });
        }
    });
}

// Add or remove the ">>>" (running) or "===" (waiting) marker on every selected node,
// following the primary node: if it has the marker, all lose it, otherwise all gain it.
function toggleMarker(kind) {
    const infos = [...selection].map(id => index.get(id)).filter(Boolean);
    const primary = index.get(selectedId)?.node;
    if (!infos.length || !primary) return;
    const has = text => (kind === 'run' ? runPrefix(text) : waitPrefix(text)) > 0;
    const on = !has(primary.text);
    commit(() => {
        for (const { node } of infos) {
            const text = node.text;
            if (has(text) === on) continue;
            const run = runPrefix(text);
            let next;
            if (kind === 'run') next = on ? `>>> ${text}` : text.slice(run);
            else if (on) next = run ? `${text.slice(0, run).trimEnd()} === ${text.slice(run)}` : `=== ${text}`;
            else next = text.slice(0, run) + text.slice(waitPrefix(text));
            setTitle(node, next);
        }
    });
}

function toggleDone(id = selectedId) {
    const info = id && index.get(id);
    if (!info?.node.task) return;
    commit(() => {
        if (info.node.task === 'done') {
            info.node.task = 'open';
        } else {
            // Completing a node completes every descendant too, including folded ones.
            walk(info.node, n => { n.task = 'done'; });
        }
        select(id);
    });
}

function toggleFold(id = selectedId) {
    const info = id && index.get(id);
    if (!info?.parent || !info.node.children.length) return;
    commit(() => {
        if (info.node.folded) delete info.node.folded;
        else info.node.folded = true;
        select(id);
    });
}

function reorder(direction) {
    const info = selectedId && index.get(selectedId);
    if (!info?.parent) return;
    const siblings = sameSideSiblings(info);
    const other = siblings[siblings.indexOf(info.node) + direction];
    if (!other) return;
    commit(() => {
        const list = info.parent.children;
        const a = list.indexOf(info.node);
        const b = list.indexOf(other);
        [list[a], list[b]] = [list[b], list[a]];
    });
    ensureVisible(selectedId);
}

function navigate(key) {
    const root = activeMap().root;
    const info = selectedId && index.get(selectedId);
    if (!info) {
        select(root.id);
        ensureVisible(root.id);
        return;
    }
    const center = id => {
        const p = positions.get(id);
        return { x: p.x + p.w / 2, y: p.y + p.h / 2 };
    };
    const here = center(info.node.id);
    const nearestY = list => list.reduce((best, n) => {
        const d = Math.abs(center(n.id).y - here.y);
        return !best || d < best.d ? { id: n.id, d } : best;
    }, null)?.id;
    let target = null;
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
        const dir = key === 'ArrowRight' ? 'right' : 'left';
        if (!info.parent) target = nearestY(root.children.filter(c => sideOf(c) === dir));
        else if (info.side === dir) target = nearestY(visibleChildren(info.node));
        else target = info.parent.id;
    } else {
        const up = key === 'ArrowUp';
        let best = null;
        for (const [id, other] of index) {
            if (id === info.node.id || !other.parent || other.side !== info.side || other.depth !== info.depth) continue;
            const c = center(id);
            const dy = c.y - here.y;
            if (up ? dy >= 0 : dy <= 0) continue;
            const score = Math.abs(dy) + Math.abs(c.x - here.x) * 0.3;
            if (!best || score < best.score) best = { id, score };
        }
        target = best?.id;
    }
    if (target) {
        select(target);
        ensureVisible(target);
    }
}

/* ---------- Drag, drop and marquee ---------- */

function toWorld(clientX, clientY) {
    return { x: (clientX - view.x) / view.z, y: (clientY - view.y) / view.z };
}

// Generous snapping: the nearest node within reach decides the drop; beyond that the
// moved branches snap to a first-level slot on whichever side of the centre the pointer is.
function findDrop(clientX, clientY) {
    const { x, y } = toWorld(clientX, clientY);
    const root = activeMap().root;
    const rp = positions.get(root.id);
    const reach = 110 / view.z;
    let best = null;
    for (const [id, p] of positions) {
        if (drag.subtree.has(id)) continue;
        const dx = Math.max(p.x - x, 0, x - (p.x + p.w));
        const dy = Math.max(p.y - y, 0, y - (p.y + p.h));
        const d = Math.hypot(dx, dy * 1.4);
        if (!best || d < best.d) best = { id, d };
    }
    const sideOfPointer = x < rp.x + rp.w / 2 ? 'left' : 'right';
    if (best && best.d <= reach) {
        const info = index.get(best.id);
        const p = positions.get(best.id);
        if (!info.parent) return { mode: 'inside', target: best.id, side: sideOfPointer };
        const outward = info.side === 'right' ? x > p.x + p.w * 0.6 : x < p.x + p.w * 0.4;
        if (outward) return { mode: 'inside', target: best.id };
        return { mode: y < p.y + p.h / 2 ? 'before' : 'after', target: best.id };
    }
    const kids = root.children.filter(c => sideOf(c) === sideOfPointer && !drag.subtree.has(c.id));
    if (!kids.length) return { mode: 'inside', target: root.id, side: sideOfPointer };
    for (const k of kids) {
        const p = positions.get(k.id);
        if (y < p.y + p.h / 2) return { mode: 'before', target: k.id };
    }
    return { mode: 'after', target: kids.at(-1).id };
}

function showDrop(drop) {
    nodesEl.querySelector('.drop-inside')?.classList.remove('drop-inside');
    dropLine.hidden = true;
    if (!drop) return;
    if (drop.mode === 'inside') {
        nodeEl(drop.target)?.classList.add('drop-inside');
        return;
    }
    const p = positions.get(drop.target);
    const info = index.get(drop.target);
    const gap = info.depth === 1 ? 11 : 4;
    dropLine.hidden = false;
    Object.assign(dropLine.style, {
        left: `${p.x}px`,
        width: `${p.w}px`,
        top: `${(drop.mode === 'before' ? p.y - gap : p.y + p.h + gap) - 1.5}px`,
    });
}

function moveNodes(sources, drop) {
    const target = index.get(drop.target);
    const root = activeMap().root;
    commit(() => {
        const newParent = drop.mode === 'inside' ? target.node : target.parent;
        for (const { node, parent } of sources) {
            parent.children.splice(parent.children.indexOf(node), 1);
        }
        let at = drop.mode === 'inside'
            ? newParent.children.length
            : newParent.children.indexOf(target.node) + (drop.mode === 'after' ? 1 : 0);
        for (const { node, parent } of sources) {
            newParent.children.splice(at++, 0, node);
            if (newParent === root) {
                node.side = drop.mode === 'inside' ? drop.side : target.side;
                if (parent !== root) node.color = nextColor(root);
            } else {
                delete node.side;
                delete node.color;
            }
            if (newParent.task) walk(node, n => { n.task ??= 'open'; });
        }
        delete newParent.folded;
    });
}

function updateMarquee(event) {
    const x1 = Math.min(drag.x0, event.clientX);
    const y1 = Math.min(drag.y0, event.clientY);
    const x2 = Math.max(drag.x0, event.clientX);
    const y2 = Math.max(drag.y0, event.clientY);
    Object.assign(marquee.style, { left: `${x1}px`, top: `${y1}px`, width: `${x2 - x1}px`, height: `${y2 - y1}px` });
    marquee.hidden = false;
    const a = toWorld(x1, y1);
    const b = toWorld(x2, y2);
    const hits = [];
    for (const [id, p] of positions) {
        if (p.x < b.x && p.x + p.w > a.x && p.y < b.y && p.y + p.h > a.y) hits.push(id);
    }
    const ids = [...drag.base, ...hits];
    setSelection(ids, hits.at(-1) ?? [...drag.base].at(-1) ?? null);
}

function cancelDrag() {
    if (!drag) return;
    endDrag({ pointerId: drag.pointerId }, true);
}

canvas.addEventListener('pointerdown', event => {
    if (drag) return;
    const el = event.target.closest('.node');
    if (editing && el && el.dataset.id === editing.id) return;
    if (event.target.closest('[data-act]')) return;
    if (editing) finishEdit(true);
    if (document.activeElement === noteText) noteText.blur();
    const base = { pointerId: event.pointerId, x0: event.clientX, y0: event.clientY };
    // Middle button or touch pans; the left button on empty canvas draws a selection box.
    if (event.button === 1 || (!el && event.pointerType === 'touch')) {
        event.preventDefault();
        drag = { ...base, kind: 'pan', vx: view.x, vy: view.y };
        return;
    }
    if (event.button !== 0) return;
    // On a Mac, Control-click is a right click: leave it to the context menu.
    if (isMac && event.ctrlKey) return;
    if (el) {
        getSelection()?.removeAllRanges();
        const id = el.dataset.id;
        if (event.shiftKey || event.metaKey || event.ctrlKey) {
            const ids = new Set(selection);
            if (ids.has(id) && ids.size > 1) {
                ids.delete(id);
                setSelection([...ids], [...ids].at(-1));
            } else {
                setSelection([...ids, id], id);
            }
            return;
        }
        if (!selection.has(id)) select(id);
        drag = { ...base, kind: 'node', id, ids: selection, movable: Boolean(index.get(id).parent), started: false };
    } else {
        const additive = event.shiftKey || event.metaKey || event.ctrlKey;
        drag = { ...base, kind: 'marquee', base: additive ? new Set(selection) : new Set(), moved: false };
    }
});

window.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.x0;
    const dy = event.clientY - drag.y0;
    if (drag.kind === 'pan') {
        canvas.classList.add('panning');
        view.x = drag.vx + dx;
        view.y = drag.vy + dy;
        applyView();
        return;
    }
    if (drag.kind === 'marquee') {
        if (!drag.moved && Math.hypot(dx, dy) < 4) return;
        if (!drag.moved) {
            drag.moved = true;
            canvas.classList.add('busy');
            getSelection().removeAllRanges();
        }
        updateMarquee(event);
        return;
    }
    if (!drag.movable) return;
    if (!drag.started) {
        if (Math.hypot(dx, dy) < 5) return;
        drag.started = true;
        canvas.classList.add('busy');
        drag.sources = [];
        drag.subtree = new Set();
        // The index visits parents before children, in tree order. Covered descendants move with their parent.
        for (const [id, info] of index) {
            if (!info.parent || !drag.ids.has(id) || drag.subtree.has(id)) continue;
            drag.sources.push(info);
            subtreeIds(info.node, drag.subtree);
        }
        for (const el of nodesEl.children) {
            if (drag.subtree.has(el.dataset.id)) el.classList.add('drag-source');
        }
        drag.ghost = document.createElement('div');
        drag.ghost.className = 'drag-ghost';
        drag.ghost.textContent = drag.sources.length > 1
            ? `移动 ${drag.sources.length} 个分支`
            : drag.sources[0].node.text || ' ';
        document.body.append(drag.ghost);
        notePanel.hidden = true;
        updateNodeBar();
    }
    drag.ghost.style.left = `${event.clientX + 12}px`;
    drag.ghost.style.top = `${event.clientY + 10}px`;
    // Nudge the canvas when dragging close to the window edge.
    const edge = 36;
    const px = event.clientX < edge ? 8 : event.clientX > innerWidth - edge ? -8 : 0;
    const py = event.clientY < edge ? 8 : event.clientY > innerHeight - edge ? -8 : 0;
    if (px || py) {
        view.x += px;
        view.y += py;
        applyView();
    }
    drag.drop = findDrop(event.clientX, event.clientY);
    showDrop(drag.drop);
});

function endDrag(event, cancelled) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const current = drag;
    drag = null;
    canvas.classList.remove('panning', 'busy');
    if (current.kind === 'pan') return;
    if (current.kind === 'marquee') {
        marquee.hidden = true;
        if (current.moved) recordTrail();
        applyFocus();
        if (!current.moved && !cancelled) {
            select(null);
            notePanel.hidden = true;
        }
        updateNodeBar();
        return;
    }
    if (!current.started) {
        if (!cancelled && selection.size > 1) select(current.id);
        return;
    }
    current.ghost.remove();
    showDrop(null);
    for (const el of nodesEl.querySelectorAll('.drag-source')) el.classList.remove('drag-source');
    if (!cancelled && current.drop) moveNodes(current.sources, current.drop);
    else updateNodeBar();
}
window.addEventListener('pointerup', event => endDrag(event, false));
window.addEventListener('pointercancel', event => endDrag(event, true));

/* Two-finger pinch on touch screens zooms around the fingers; moving both fingers also pans. */
const touches = new Map();      // pointerId -> { x, y } for fingers on the canvas
let pinch = null;

function pinchSpan() {
    const [a, b] = touches.values();
    return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
}

// Runs before the normal pointerdown handler, so a second finger never starts a drag of its own.
canvas.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch') return;
    // The first finger of a new gesture starts afresh, in case a lift was ever missed.
    if (event.isPrimary) {
        touches.clear();
        pinch = null;
    }
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touches.size < 2) return;
    event.stopImmediatePropagation();
    if (touches.size > 2) return;
    // Whatever the first finger started (pan, node drag, selection box) becomes a pinch.
    cancelDrag();
    closeMenu();
    startPinch();
}, true);

function startPinch() {
    const span = pinchSpan();
    pinch = { ...span, z: view.z, wx: (span.mx - view.x) / view.z, wy: (span.my - view.y) / view.z };
}

window.addEventListener('pointermove', event => {
    if (!touches.has(event.pointerId)) return;
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (!pinch) return;
    // Keep the map point that started under the fingers' midpoint under it, at the new scale.
    const span = pinchSpan();
    const z = clamp(pinch.z * span.dist / pinch.dist, MIN_ZOOM, MAX_ZOOM);
    view = { z, x: span.mx - pinch.wx * z, y: span.my - pinch.wy * z };
    applyView();
});

function liftTouch(event) {
    if (!touches.delete(event.pointerId) || !pinch) return;
    // With three fingers down, lifting one pinches on with the other two from where it is now.
    if (touches.size >= 2) return startPinch();
    pinch = null;
    // The finger still down carries on panning.
    const [rest] = touches;
    if (rest) drag = { pointerId: rest[0], x0: rest[1].x, y0: rest[1].y, kind: 'pan', vx: view.x, vy: view.y };
}
window.addEventListener('pointerup', liftTouch);
window.addEventListener('pointercancel', liftTouch);
canvas.addEventListener('auxclick', event => event.preventDefault());

function nodeTitleTarget(target) {
    const el = target.closest('.node');
    if (el && editing?.id !== el.dataset.id && !target.closest('[data-act]')) return el;
    return null;
}

canvas.addEventListener('dblclick', event => {
    const el = nodeTitleTarget(event.target);
    if (el) startEdit(el.dataset.id);
});

// Safari can send two single clicks without dblclick when page zoom is disabled.
const NODE_TAP_INTERVAL = 350;
const NODE_TAP_SLOP = 5;
const NODE_DOUBLE_TAP_RADIUS = 24;
let nodeTouch = null;
let lastNodeTap = null;

function clearNodeTaps() {
    nodeTouch = lastNodeTap = null;
}

document.addEventListener('touchstart', event => {
    const el = nodeTitleTarget(event.target);
    if (event.touches.length !== 1 || !el) return clearNodeTaps();
    const { clientX, clientY } = event.changedTouches[0];
    nodeTouch = { id: el.dataset.id, x: clientX, y: clientY, time: event.timeStamp };
}, { passive: true });

function movedPastNodeTap(touch) {
    return Math.hypot(touch.clientX - nodeTouch.x, touch.clientY - nodeTouch.y) >= NODE_TAP_SLOP;
}

canvas.addEventListener('touchmove', event => {
    if (nodeTouch && movedPastNodeTap(event.touches[0])) clearNodeTaps();
}, { passive: true });
document.addEventListener('touchcancel', clearNodeTaps);

canvas.addEventListener('touchend', event => {
    if (!nodeTouch) return;
    if (movedPastNodeTap(event.changedTouches[0]) || event.timeStamp - nodeTouch.time > NODE_TAP_INTERVAL) {
        clearNodeTaps();
        return;
    }
    const { id, x, y, time } = nodeTouch;
    const previous = lastNodeTap;
    nodeTouch = null;
    lastNodeTap = { id, x, y, time: event.timeStamp };
    if (previous?.id !== id || time - previous.time > NODE_TAP_INTERVAL
        || Math.hypot(x - previous.x, y - previous.y) > NODE_DOUBLE_TAP_RADIUS) return;
    clearNodeTaps();
    // Focus from a real touch event so iOS can open its keyboard.
    event.preventDefault();
    startEdit(id);
}, { passive: false });

nodesEl.addEventListener('click', event => {
    const act = event.target.closest('[data-act]');
    if (!act) return;
    const id = act.closest('.node').dataset.id;
    switch (act.dataset.act) {
        case 'check': toggleDone(id); break;
        case 'note': openNote(id); break;
        case 'fold': toggleFold(id); break;
        case 'add': addChild(id, act.dataset.side); break;
    }
});

/* ---------- Notes ---------- */

function openNote(id = selectedId) {
    if (!id || !index.has(id)) return;
    if (editing) finishEdit(true);
    helpPanel.hidden = true;
    select(id);
    noteFor = id;
    notePanel.hidden = false;
    syncNote();
    positionNote();
    noteText.focus({ preventScroll: true });
}

function closeNote() {
    notePanel.hidden = true;
    noteFor = null;
    noteText.blur();
    updateNodeBar();
}

function syncNote() {
    if (notePanel.hidden) return;
    const node = selection.size === 1 && index.get(selectedId)?.node;
    if (!node) {
        notePanel.hidden = true;
        noteFor = null;
        return;
    }
    noteFor = node.id;
    $('note-title').textContent = node.text || '备注';
    if (noteSession?.id !== node.id) noteText.value = node.note;
    positionNote();
}

// The note editor floats beside its node, on the side the branch grows, and flips or
// slides to stay inside the window.
function positionNote() {
    if (notePanel.hidden || !noteFor) return;
    const el = nodeEl(noteFor);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w = notePanel.offsetWidth;
    const h = notePanel.offsetHeight;
    const gap = 12;
    const preferLeft = index.get(noteFor)?.side === 'left' && index.get(noteFor)?.parent;
    const fitsRight = r.right + gap + w <= innerWidth - MARGIN;
    const fitsLeft = r.left - gap - w >= MARGIN;
    let x;
    let y = r.top - 6;
    if (preferLeft ? fitsLeft : !fitsRight && fitsLeft) x = r.left - gap - w;
    else if (fitsRight) x = r.right + gap;
    else {
        x = r.left + r.width / 2 - w / 2;
        y = r.bottom + gap;
        if (y + h > innerHeight - MARGIN) y = r.top - gap - h;
    }
    x = clamp(x, MARGIN, innerWidth - MARGIN - w);
    y = clamp(y, MARGIN, innerHeight - MARGIN - h);
    notePanel.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

noteText.addEventListener('focus', () => {
    noteSession = { id: noteFor, snap: snapshot(), dirty: false };
});
noteText.addEventListener('blur', () => { noteSession = null; });
noteText.addEventListener('input', () => {
    const info = noteSession && index.get(noteSession.id);
    if (!info) return;
    if (!noteSession.dirty) {
        pushUndo(noteSession.snap);
        noteSession.dirty = true;
    }
    const hadNote = Boolean(info.node.note);
    info.node.note = noteText.value;
    touched();
    if (hadNote !== Boolean(info.node.note)) {
        nodeEl(info.node.id).replaceWith(buildNode(info));
        relayout();
    }
    updateHistoryButtons();
});
noteText.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
        event.preventDefault();
        const id = noteFor;
        closeNote();
        if (id) select(id);
    }
});
new ResizeObserver(() => positionNote()).observe(notePanel);

/* ---------- Files ---------- */

function openMap(id) {
    if (editing) finishEdit(true);
    state.activeId = id;
    select(null);
    fadeTrail = [];
    notePanel.hidden = true;
    scheduleSave();
    render();
    fit();
}

function newMap() {
    const map = createMap('');
    state.maps.unshift(map);
    openMap(map.id);
    sync.markDirty();
    startEdit(map.root.id);
}

function formatDate(time) {
    const d = new Date(time);
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    if (d.toDateString() === now.toDateString()) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function renderSidebar() {
    const sorted = [...state.maps].sort((a, b) => (b.updated || 0) - (a.updated || 0));
    fileList.replaceChildren(...sorted.map(map => {
        const li = document.createElement('li');
        li.className = 'file';
        li.dataset.id = map.id;
        li.tabIndex = 0;
        li.classList.toggle('active', map.id === state.activeId && !selectMode);
        li.classList.toggle('checked', selectMode && checked.has(map.id));
        if (selectMode) {
            const tick = document.createElement('span');
            tick.className = 'tick';
            li.append(tick);
        }
        const meta = document.createElement('div');
        meta.className = 'meta';
        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = map.root.text.trim() || '未命名导图';
        const sub = document.createElement('div');
        sub.className = 'sub';
        sub.textContent = `${formatDate(map.updated || map.created)} · ${countNodes(map.root)} 个节点`;
        meta.append(name, sub);
        li.append(meta);
        return li;
    }));
    $('select-toggle').setAttribute('aria-pressed', String(selectMode));
    $('batch-bar').hidden = !selectMode;
    $('batch-count').textContent = `已选 ${checked.size} 份`;
    $('select-all').textContent = checked.size === state.maps.length ? '取消全选' : '全选';
    for (const cmd of ['batch-export', 'batch-delete']) {
        document.querySelector(`[data-cmd="${cmd}"]`).disabled = !checked.size;
    }
}

function activateFile(id) {
    if (selectMode) {
        if (checked.has(id)) checked.delete(id);
        else checked.add(id);
        renderSidebar();
    } else if (id !== state.activeId) {
        openMap(id);
    }
}
fileList.addEventListener('click', event => {
    const li = event.target.closest('.file');
    if (li) activateFile(li.dataset.id);
});
fileList.addEventListener('keydown', event => {
    const li = event.target.closest('.file');
    if (li && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        activateFile(li.dataset.id);
    }
});

function toggleSidebar(open = sidebar.hidden) {
    sidebar.hidden = !open;
    document.body.classList.toggle('sidebar-open', open);
    for (const b of document.querySelectorAll('[data-cmd="sidebar"]')) b.setAttribute('aria-expanded', String(open));
    if (open) renderSidebar();
    else {
        selectMode = false;
        checked.clear();
    }
}

function safeName(name) {
    return (name.trim() || '未命名导图').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80);
}

function download(map) {
    const blob = new Blob([exportOPML(map)], { type: 'text/x-opml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName(map.root.text)}.opml`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function exportMaps(maps) {
    if (editing) finishEdit(true);
    maps.forEach((map, i) => setTimeout(() => download(map), i * 250));
    toast(maps.length > 1 ? `正在导出 ${maps.length} 份 OPML` : '已导出 OPML');
}

function deleteChecked() {
    const n = checked.size;
    if (!n || !confirm(`删除所选的 ${n} 份导图？此操作无法撤销。`)) return;
    const now = Date.now();
    state.maps = state.maps.filter(m => !checked.has(m.id));
    for (const id of checked) {
        histories.delete(id);
        state.deletedMaps[id] = now;
    }
    checked.clear();
    selectMode = false;
    if (!state.maps.length) state.maps.push(createMap());
    if (!activeMap()) openMap(state.maps[0].id);
    saveNow();
    sync.markDirty();
    renderSidebar();
    toast(`已删除 ${n} 份导图`);
}

fileInput.addEventListener('change', async () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    if (!files.length) return;
    const imported = [];
    const failed = [];
    for (const file of files) {
        try {
            imported.push(importOPML(await file.text(), file.name));
        } catch (error) {
            failed.push(`${file.name}（${error.message}）`);
        }
    }
    if (imported.length) {
        state.maps.unshift(...imported);
        openMap(imported[0].id);
        saveNow();
        sync.markDirty();
    }
    const parts = [];
    if (imported.length) parts.push(`已导入 ${imported.length} 份导图`);
    if (failed.length) parts.push(`无法导入：${failed.join('、')}`);
    toast(parts.join('；'), failed.length ? 5000 : 2400);
});

/* ---------- Commands ---------- */

let toastTimer;
function toast(message, ms = 2400) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* ---------- Context menu ---------- */

const menu = $('context-menu');
let menuItems = [];

// Right-click on a node shows its actions; right-click anywhere else does nothing. Text fields
// (title being edited, note, inputs) keep the browser menu for copy and paste.
document.addEventListener('contextmenu', event => {
    if (event.target.closest('textarea, input, [contenteditable]')) return;
    event.preventDefault();
    const el = event.target.closest('.node');
    if (el && nodesEl.contains(el) && !drag) openMenu(el.dataset.id, event.clientX, event.clientY);
    else closeMenu();
});

function openMenu(id, x, y) {
    if (editing) finishEdit(true);
    // Right-clicking inside a multi-selection acts on all of it; anywhere else selects just that node.
    if (!selection.has(id)) select(id);
    else if (selectedId !== id) setSelection([...selection], id);
    const info = index.get(id);
    if (!info) return;
    const { node } = info;
    const multi = selection.size > 1;
    const isRoot = !info.parent;
    const deletable = [...selection].some(s => index.get(s)?.parent);
    const cuttable = !selection.has(activeMap().root.id);
    const keyMod = isMac ? '⌘' : 'Ctrl+';
    const groups = multi ? [
        [
            { icon: 'copy', label: '复制', keys: `${keyMod}C`, run: () => copySelected() },
            cuttable && { icon: 'cut', label: '剪切', keys: `${keyMod}X`, run: () => cutSelected() },
        ],
        [
            { icon: 'task', label: node.task ? '移除待办' : '设为待办', keys: '⌥T', run: toggleTask },
        ],
        [
            { icon: 'run', label: runPrefix(node.text) ? '取消执行中' : '标记为执行中', keys: '>>>', run: () => toggleMarker('run') },
            { icon: 'hourglass', label: waitPrefix(node.text) ? '结束等待' : '开始等待', keys: '===', run: () => toggleMarker('wait') },
        ],
        [
            deletable && { icon: 'trash', label: `删除 ${selection.size} 个节点`, keys: '⌫', run: deleteSelected, danger: true },
        ],
    ] : [
        [
            { icon: 'edit', label: '编辑标题', keys: '空格', run: () => startEdit(id) },
            { icon: 'child', label: '新建子节点', keys: 'Tab', run: () => addChild() },
            !isRoot && { icon: 'sibling', label: '新建同级节点', keys: '↵', run: () => addSibling('after') },
        ],
        [
            { icon: 'copy', label: '复制', keys: `${keyMod}C`, run: () => copySelected() },
            !isRoot && { icon: 'cut', label: '剪切', keys: `${keyMod}X`, run: () => cutSelected() },
            hasClipboard() && { icon: 'paste', label: '粘贴为子节点', keys: `${keyMod}V`, run: () => pasteNodes(id) },
        ],
        [
            { icon: 'task', label: node.task ? '移除待办' : '设为待办', keys: '⌥T', run: toggleTask },
            node.task && { icon: node.task === 'done' ? 'circle' : 'circle-check', label: node.task === 'done' ? '标记为未完成' : '标记为完成', keys: '⌥C', run: () => toggleDone(id) },
            { icon: 'note', label: node.note ? '编辑备注' : '添加备注', keys: '⌥N', run: () => openNote(id) },
            !isRoot && node.children.length > 0 && { icon: 'chevron', label: node.folded ? '展开' : '折叠', keys: '⌥.', run: () => toggleFold(id) },
        ],
        [
            { icon: 'run', label: runPrefix(node.text) ? '取消执行中' : '标记为执行中', keys: '>>>', run: () => toggleMarker('run') },
            { icon: 'hourglass', label: waitPrefix(node.text) ? '结束等待' : '开始等待', keys: '===', run: () => toggleMarker('wait') },
        ],
        [
            !isRoot && { icon: 'trash', label: '删除', keys: '⌫', run: deleteSelected, danger: true },
        ],
    ];
    const parts = [];
    if (multi) {
        const head = document.createElement('div');
        head.className = 'menu-head';
        head.textContent = `已选 ${selection.size} 个节点`;
        parts.push(head);
    }
    menuItems = [];
    for (const group of groups.map(g => g.filter(Boolean)).filter(g => g.length)) {
        if (menuItems.length) {
            const sep = document.createElement('div');
            sep.className = 'menu-sep';
            parts.push(sep);
        }
        for (const item of group) {
            const b = document.createElement('button');
            b.className = `menu-item${item.danger ? ' danger' : ''}`;
            b.setAttribute('role', 'menuitem');
            b.tabIndex = -1;
            b.innerHTML = `${icon(item.icon)}<span class="label"></span><span class="keys"></span>`;
            b.querySelector('.label').textContent = item.label;
            b.querySelector('.keys').textContent = item.keys;
            b.action = item.run;
            parts.push(b);
            menuItems.push(b);
        }
    }
    menu.replaceChildren(...parts);
    menu.hidden = false;
    // Open at the pointer, flipped back inside the window near the edges.
    const { width, height } = menu.getBoundingClientRect();
    menu.style.left = `${clamp(x + width > innerWidth - 8 ? x - width : x, 8, innerWidth - width - 8)}px`;
    menu.style.top = `${clamp(y + height > innerHeight - 8 ? y - height : y, 8, innerHeight - height - 8)}px`;
    setActive(-1);
    menu.focus({ preventScroll: true });
}

function closeMenu() {
    if (menu.hidden) return;
    menu.hidden = true;
    menuItems = [];
    if (document.activeElement === menu) menu.blur();
}

function setActive(i) {
    menuItems.forEach((b, j) => b.classList.toggle('active', j === i));
}

function runMenuItem(b) {
    closeMenu();
    b.action();
}

menu.addEventListener('pointermove', event => {
    const b = event.target.closest('.menu-item');
    if (b) setActive(menuItems.indexOf(b));
});
menu.addEventListener('pointerleave', () => setActive(-1));
menu.addEventListener('click', event => {
    const b = event.target.closest('.menu-item');
    if (b) runMenuItem(b);
});
menu.addEventListener('contextmenu', event => event.preventDefault());
menu.addEventListener('keydown', event => {
    event.stopPropagation();
    const i = menuItems.findIndex(b => b.classList.contains('active'));
    const n = menuItems.length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setActive(event.key === 'ArrowDown' ? (i + 1) % n : (i <= 0 ? n : i) - 1);
    } else if ((event.key === 'Enter' || event.key === ' ') && i >= 0) {
        event.preventDefault();
        runMenuItem(menuItems[i]);
    } else if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        closeMenu();
    }
});
// Any press outside, scrolling, resizing or leaving the window closes the menu.
document.addEventListener('pointerdown', event => {
    if (!menu.contains(event.target)) closeMenu();
}, true);
window.addEventListener('wheel', closeMenu, { passive: true });
window.addEventListener('resize', closeMenu);
window.addEventListener('blur', closeMenu);

/* ---------- Cloud Sync (Optional GitHub Private Repo) ---------- */

const syncBar = $('sync-bar');
const syncBtn = $('sync-btn');
const syncIcon = $('sync-icon');
const syncLabel = $('sync-label');
const syncSep = $('sync-sep');
const syncSettingsBtn = $('sync-settings-btn');

const SYNC_UI = {
    unconfigured: { icon: '#i-cloud', label: '云同步', spin: false },
    synced: { icon: '#i-cloud-check', label: '已同步', spin: false },
    dirty: { icon: '#i-cloud-up', label: '待同步', spin: false },
    syncing: { icon: '#i-sync', label: '同步中', spin: true },
    error: { icon: '#i-cloud-alert', label: '同步失败', spin: false },
};

function updateSyncUI(info) {
    const cfg = SYNC_UI[info.state] || SYNC_UI.unconfigured;
    syncBar.dataset.state = info.state;
    syncIcon.querySelector('use').setAttribute('href', cfg.icon);
    syncIcon.classList.toggle('csync-spinning', cfg.spin);
    syncLabel.textContent = cfg.label;
    syncSep.hidden = !info.configured;
    syncSettingsBtn.hidden = !info.configured;

    const saveKey = isMac ? '⌘S' : 'Ctrl+S';
    if (!info.configured) {
        syncBtn.title = '配置 Cloudflare 云同步（可选）';
    } else if (info.state === 'syncing') {
        syncBtn.title = `正在与 ${info.host} 同步…`;
    } else if (info.state === 'error') {
        syncBtn.title = `同步失败：${info.lastError || '网络错误'} · 点击重试`;
    } else if (info.state === 'dirty') {
        syncBtn.title = `本地有未同步改动 · 点击立即同步 (${saveKey})`;
    } else {
        syncBtn.title = `已同步 (${formatSyncTime(info.lastSyncAt)}) · 点击立即同步 (${saveKey})`;
    }
}

const sync = createCloudSync({
    appId: 'mymind',
    appName: 'MyMind',
    autoSyncIntervalMs: 5 * 60 * 1000,
    getLocalData: () => ({
        version: 1,
        maps: state.maps,
        deletedMaps: state.deletedMaps || {},
    }),
    mergeData: (local, remote, { metaExtra }) => mergeMindStates(local, remote, {
        baseUpdated: metaExtra?.baseUpdated,
    }),
    applyMergedData: (merged) => {
        const prevActiveId = state.activeId;
        const prevActiveRoot = activeMap() ? JSON.stringify(activeMap().root) : '';
        state.maps = merged.maps.length ? merged.maps : [sampleMap()];
        state.deletedMaps = merged.deletedMaps || {};
        const stillExists = state.maps.some(m => m.id === prevActiveId);
        state.activeId = stillExists ? prevActiveId : state.maps[0].id;
        if (!stillExists || JSON.stringify(activeMap().root) !== prevActiveRoot) {
            histories.delete(state.activeId);
        }
        saveNow();
        render();
        if (!stillExists) fit();
    },
    isBusy: () => Boolean(editing || drag),
    onStatusChange: updateSyncUI,
    onToast: (msg, opts) => toast(msg, opts?.duration || 2600),
});

function triggerManualSync() {
    if (editing) finishEdit(true);
    if (saveTimer) saveNow();
    if (sync.isConfigured()) {
        sync.syncNow({ manual: true });
    } else {
        sync.openSettings();
    }
}

// ⌘S / Ctrl+S is muscle memory: flush any pending local edit/save, and trigger forced cloud sync if enabled.
window.addEventListener('keydown', event => {
    if ((isMac ? event.metaKey : event.ctrlKey) && !event.altKey && event.code === 'KeyS') {
        event.preventDefault();
        if (sync.isModalOpen()) return;
        if (editing) finishEdit(true);
        if (saveTimer) saveNow();
        if (sync.isConfigured()) sync.syncNow({ manual: true });
        else toast('已保存到本地');
    }
}, true);

const commands = {
    sidebar: () => toggleSidebar(),
    new: newMap,
    import: () => fileInput.click(),
    'edit-root': () => {
        const id = activeMap().root.id;
        ensureVisible(id);
        startEdit(id);
    },
    undo, redo,
    export: () => exportMaps([activeMap()]),
    focus: () => setViewMode('focus'),
    fade: () => setViewMode('fade'),
    help: () => {
        helpPanel.hidden = !helpPanel.hidden;
        if (!helpPanel.hidden) closeNote();
        document.querySelector('.tool-bar [data-cmd="help"]').setAttribute('aria-pressed', String(!helpPanel.hidden));
    },
    'sync-now': triggerManualSync,
    'sync-settings': () => sync.openSettings(),
    child: () => addChild(),
    sibling: () => addSibling('after'),
    copy: () => copySelected(),
    paste: () => pasteNodes(),
    task: toggleTask,
    note: () => (notePanel.hidden ? openNote() : closeNote()),
    'close-note': closeNote,
    delete: deleteSelected,
    'zoom-in': () => zoomAt(view.z * 1.2),
    'zoom-out': () => zoomAt(view.z / 1.2),
    'zoom-reset': () => zoomAt(1),
    fit,
    'select-mode': () => {
        selectMode = !selectMode;
        checked.clear();
        renderSidebar();
    },
    'select-all': () => {
        if (checked.size === state.maps.length) checked.clear();
        else state.maps.forEach(m => checked.add(m.id));
        renderSidebar();
    },
    'batch-export': () => exportMaps(state.maps.filter(m => checked.has(m.id))),
    'batch-delete': deleteChecked,
};

// Keep focus (and an active title edit) when pressing floating buttons.
document.addEventListener('mousedown', event => {
    if (event.target.closest('.pill [data-cmd]')) event.preventDefault();
});
document.addEventListener('click', event => {
    const button = event.target.closest('[data-cmd]');
    if (button && !button.disabled) commands[button.dataset.cmd]?.();
});

document.addEventListener('keydown', event => {
    if (editing || event.isComposing || sync.isModalOpen()) return;
    if (drag && event.key === 'Escape') {
        cancelDrag();
        return;
    }
    const target = event.target;
    if (target.closest?.('textarea, input, [contenteditable]')) return;
    if (target.closest?.('#sidebar') && (event.key === 'Enter' || event.key === ' ')) return;
    const mod = isMac ? event.metaKey : event.ctrlKey;
    const key = event.key;

    if (mod && !event.altKey) {
        const lower = key.toLowerCase();
        if (lower === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
        else if (lower === 'y' && !isMac) { event.preventDefault(); redo(); }
        else if (lower === 'a' && !event.shiftKey) { event.preventDefault(); setSelection([...index.keys()], selectedId ?? activeMap().root.id); }
        else if (!event.shiftKey && (lower === 'c' || (key === 'Process' && event.code === 'KeyC'))) {
            if (!getSelection()?.toString() && selection.size) {
                event.preventDefault();
                lastClipboardKeyAt = performance.now();
                copySelected();
            }
        } else if (!event.shiftKey && (lower === 'x' || (key === 'Process' && event.code === 'KeyX'))) {
            if (!getSelection()?.toString() && selection.size) {
                event.preventDefault();
                lastClipboardKeyAt = performance.now();
                cutSelected();
            }
        } else if (!event.shiftKey && (lower === 'v' || (key === 'Process' && event.code === 'KeyV'))) {
            if (hasClipboard()) {
                event.preventDefault();
                lastClipboardKeyAt = performance.now();
                pasteNodes();
            }
        }
        else if (key === '=' || key === '+') { event.preventDefault(); commands['zoom-in'](); }
        else if (key === '-') { event.preventDefault(); commands['zoom-out'](); }
        else if (key === '0') { event.preventDefault(); zoomAt(1); }
        else if (key === '9') { event.preventDefault(); fit(); }
        else if (key === 'ArrowUp' || key === 'ArrowDown') { event.preventDefault(); reorder(key === 'ArrowUp' ? -1 : 1); }
        return;
    }
    if (event.metaKey || event.ctrlKey) return;

    if (event.altKey) {
        if (event.code === 'KeyF' || event.code === 'KeyG') {
            event.preventDefault();
            setViewMode(event.code === 'KeyF' ? 'focus' : 'fade');
            return;
        }
        const actions = { KeyT: toggleTask, KeyC: () => toggleDone(), KeyN: () => openNote(), Period: () => toggleFold() };
        if (actions[event.code] && selectedId) {
            event.preventDefault();
            actions[event.code]();
        }
        return;
    }

    if (key === 'Escape') {
        if (!helpPanel.hidden) commands.help();
        else if (!notePanel.hidden) closeNote();
        else select(null);
        return;
    }
    if (!selectedId) {
        if (['Tab', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key) && target === document.body) {
            event.preventDefault();
            navigate(key);
        }
        return;
    }
    switch (key) {
        case 'Tab': event.preventDefault(); if (!event.shiftKey) addChild(); return;
        case 'Enter': event.preventDefault(); addSibling(event.shiftKey ? 'before' : 'after'); return;
        case ' ': case 'F2': event.preventDefault(); startEdit(selectedId); return;
        case 'Backspace': case 'Delete': event.preventDefault(); deleteSelected(); return;
        case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight':
            event.preventDefault();
            navigate(key);
            return;
    }
    // Typing on a selected node starts replacing its title. Focus moves before the
    // character is inserted, so the keystroke (or IME composition) lands in the node.
    if (key.length === 1 || key === 'Process' || event.keyCode === 229) startEdit(selectedId, { replace: '' });
});

// Support browser Edit menu copy/cut/paste without double-firing after keyboard shortcuts.
function canHandleClipboardEvent(event) {
    return !editing && !drag && !sync.isModalOpen() && !event.target.closest?.('textarea, input, [contenteditable]');
}
document.addEventListener('copy', event => {
    if (!canHandleClipboardEvent(event)) return;
    if (performance.now() - lastClipboardKeyAt < 100) { event.preventDefault(); return; }
    if (getSelection()?.toString() || !selection.size) return;
    event.preventDefault();
    copySelected(event.clipboardData);
});
document.addEventListener('cut', event => {
    if (!canHandleClipboardEvent(event)) return;
    if (performance.now() - lastClipboardKeyAt < 100) { event.preventDefault(); return; }
    if (getSelection()?.toString() || !selection.size) return;
    event.preventDefault();
    cutSelected(event.clipboardData);
});
document.addEventListener('paste', event => {
    if (!canHandleClipboardEvent(event)) return;
    if (performance.now() - lastClipboardKeyAt < 100) { event.preventDefault(); return; }
    if (!hasClipboard()) return;
    event.preventDefault();
    pasteNodes();
});

function renderHelp() {
    const rows = [
        ['新建子节点', 'Tab'],
        ['新建同级节点', 'Enter'],
        ['在上方新建同级', '⇧ Enter'],
        ['编辑标题', '空格 / 双击'],
        ['标题内换行', '⇧ Enter'],
        ['结束 / 取消编辑', 'Enter / Esc'],
        ['选择节点', '↑ ↓ ← →'],
        ['框选 / 加选', '拖动空白处 / ⇧ 点击'],
        ['批量移动节点', '多选后拖动其中一个节点'],
        ['全选', `${MOD}A`],
        ['调整顺序', `${MOD}↑ / ${MOD}↓`],
        ['复制 / 剪切节点', `${MOD}C / ${MOD}X`],
        ['粘贴为子节点', `${MOD}V`],
        ['删除所选节点', 'Delete'],
        ['节点快捷菜单', '右键'],
        ['折叠 / 展开', '⌥ .'],
        ['添加 / 移除待办', '⌥ T'],
        ['完成待办', '⌥ C'],
        ['备注', '⌥ N'],
        ['专注模式', '⌥ F'],
        ['渐隐模式', '⌥ G'],
        ['截止日期（标题末尾）', '11.20 / 11-20 / 11.20 23:00'],
        ['快捷日期（保存时转成日期）', 'today / tmr / sun / next mon / 23:32'],
        ['等待中（标题开头）', '=== QA testing'],
        ['执行中（标题开头，整棵子树高亮）', '>>> 写周报'],
        ['撤销 / 重做', `${MOD}Z / ⇧${MOD}Z`],
        ['保存 / 强制云同步', `${MOD}S`],
        ['上下 / 左右移动画布', '滚轮 / ⇧ 滚轮'],
        ['以鼠标为中心缩放', `${MOD} 滚轮`],
        ['拖动画布', '中键拖动'],
        ['实际大小 / 适应窗口', `${MOD}0 / ${MOD}9`],
    ];
    $('help-list').replaceChildren(...rows.map(([label, keys]) => {
        const row = document.createElement('div');
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        keys.split(' / ').forEach((k, i) => {
            if (i) dd.append(' / ');
            const kbd = document.createElement('kbd');
            kbd.textContent = k;
            dd.append(kbd);
        });
        row.append(dt, dd);
        return row;
    }));
    if (!isMac) {
        document.querySelector('[data-cmd="undo"]').title = '撤销 (Ctrl+Z)';
        document.querySelector('[data-cmd="redo"]').title = '重做 (Ctrl+Shift+Z)';
        document.querySelector('[data-cmd="copy"]').title = '复制 (Ctrl+C)';
        document.querySelector('[data-cmd="paste"]').title = '粘贴为子节点 (Ctrl+V)';
    }
}

/* ---------- Start ---------- */

function checkVersionUpdate(hadExistingData) {
    let seen = null;
    try { seen = localStorage.getItem(VERSION_STORE); } catch { return; }
    const upgraded = seen ? compareVersions(APP_VERSION, seen) > 0 : hadExistingData;
    if (!seen || upgraded) {
        try { localStorage.setItem(VERSION_STORE, APP_VERSION); } catch { /* not critical */ }
    }
    if (upgraded) {
        const note = RELEASES[0]?.note;
        toast(note ? `已更新至 v${APP_VERSION}：${note}` : `已更新至 v${APP_VERSION}`, 4500);
    }
}

let hadExistingData = false;
try { hadExistingData = localStorage.getItem(STORE) !== null; } catch { /* storage unavailable */ }
load();
$('app-version').textContent = `v${APP_VERSION}`;
renderHelp();
syncViewButtons();
render();
fit();
checkVersionUpdate(hadExistingData);
sync.start();
addEventListener('resize', () => applyView());

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register(new URL('./sw.js', import.meta.url))
        .then(() => navigator.serviceWorker.ready)
        .then(() => {
            // ready resolves only after install (which precaches the shell) succeeded.
            const key = 'mymind.offline.ready.v1';
            if (!localStorage.getItem(key)) {
                localStorage.setItem(key, '1');
                toast('离线已就绪，断网也能打开', 2600);
            }
        })
        .catch(error => {
            console.warn('MyMind service worker registration failed', error);
        });
}
