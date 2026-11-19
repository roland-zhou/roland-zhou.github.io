import {
    PALETTE_SIZE, buildIndex, computeLayout, countNodes, createMap, createNode,
    dueStatus, exportOPML, importOPML, isValidMap, nextColor, nextWaitSince, parseDue, sampleMap, subtreeIds,
    visibleChildren, waitDuration, waitPrefix, waitShort,
} from './model.js';

const STORE = 'mymind.v1';
const FOCUS_STORE = 'mymind.focus';

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

let state = { maps: [], activeId: null };
let index = new Map();
let positions = new Map();
let selectedId = null;          // primary (focused) node
let selection = new Set();      // all selected nodes, always includes selectedId
let editing = null;
let drag = null;
let view = { x: 0, y: 0, z: 1 };
let selectMode = false;
const checked = new Set();
const histories = new Map();
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
    if (event.key !== STORE || !event.newValue) return;
    try {
        const data = JSON.parse(event.newValue);
        if (!Array.isArray(data.maps)) return;
        if (editing) finishEdit(false);
        const keep = state.activeId;
        state.maps = data.maps.filter(isValidMap);
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
    activeMap().updated = Date.now();
    scheduleSave();
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

// A leading "===" becomes a waiting badge, and a trailing "MM-DD" or "MM-DD HH:MM" a deadline badge.
function fillText(el, node) {
    const done = node.task === 'done';
    const parts = [];
    let value = node.text;
    const wait = waitPrefix(value);
    if (wait) {
        parts.push(waitBadge(node.waitSince, done));
        value = value.slice(wait);
    }
    const due = parseDue(value);
    if (due) {
        const badge = document.createElement('span');
        badge.className = 'due';
        badge.textContent = value.slice(due.index);
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
    <path class="glass" d="M5 3h14M5 21h14M6.4 3c0 5.2 4.6 6.6 4.6 9s-4.6 3.8-4.6 9h11.2c0-5.2-4.6-6.6-4.6-9s4.6-3.8 4.6-9z"/>
    <path class="sand top" d="M16.4 5.2H7.6c.5 2.6 2.6 4.4 4.4 5.6 1.8-1.2 3.9-3 4.4-5.6z"/>
    <path class="sand bottom" d="M7.6 18.8h8.8c-.5-2.6-2.6-4.4-4.4-5.6-1.8 1.2-3.9 3-4.4 5.6z"/>
    <path class="sand stream" d="M11.55 11h.9v7h-.9z"/>
</svg>`;

// Turn the hourglass over once, e.g. when the waiting time moves on to the next step.
function flipHourglass(badge) {
    const glass = badge.querySelector('.hourglass');
    glass.classList.remove('flip');
    void glass.getBoundingClientRect();   // restart the animation if it is still running
    glass.classList.add('flip');
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
function paintDue(badge, now = new Date()) {
    const { state, days, hours } = dueStatus(badge.due, now);
    let strength = 1;
    if (state === 'overdue') strength = 1 - 0.85 * clamp01((days - 7) / 23);
    else if (state === 'upcoming') strength = 1 - clamp01((days - 3) / 11);
    if (badge.done) strength = 0;
    badge.dataset.state = state;
    badge.classList.toggle('pale', strength < 0.7);
    badge.style.setProperty('--due-mix', `${Math.round(strength * 100)}%`);
    badge.title = badge.done ? '已完成' : state === 'today' ? '今天到期' : state === 'overdue' ? (days ? `已过期 ${days} 天` : hours ? `已过期 ${hours} 小时` : '刚刚过期') : `还有 ${days} 天`;
}

// Re-paint every minute so deadlines and waiting times move on without a re-render.
setInterval(() => {
    const now = new Date();
    for (const badge of nodesEl.querySelectorAll('.due')) paintDue(badge, now);
    let grew = false;
    for (const badge of nodesEl.querySelectorAll('.wait')) grew = paintWait(badge, now.getTime()) || grew;
    if (grew) relayout();
}, 60e3);

function render() {
    const map = activeMap();
    index = buildIndex(map.root);
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
function shade(el, levels) {
    const level = levels ? levels.get(el.dataset.id) ?? FADE_STEPS : 0;
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
    const value = readText(text);
    // "===" starts a waiting clock; editing the rest of the title keeps it running.
    const waitSince = nextWaitSince(value, node.waitSince);
    if (value !== node.text || waitSince !== node.waitSince) {
        if (!created) pushUndo(snap);
        node.text = value;
        if (waitSince === undefined) delete node.waitSince;
        else node.waitSince = waitSince;
        touched();
    }
    render();
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
// node snaps to a first-level slot on whichever side of the centre the pointer is.
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

function moveNode(id, drop) {
    const info = index.get(id);
    const target = index.get(drop.target);
    const root = activeMap().root;
    commit(() => {
        const node = info.node;
        const newParent = drop.mode === 'inside' ? target.node : target.parent;
        info.parent.children.splice(info.parent.children.indexOf(node), 1);
        const at = drop.mode === 'inside'
            ? newParent.children.length
            : newParent.children.indexOf(target.node) + (drop.mode === 'after' ? 1 : 0);
        newParent.children.splice(at, 0, node);
        delete newParent.folded;
        if (newParent === root) {
            node.side = drop.mode === 'inside' ? drop.side : target.side;
            if (info.parent !== root) node.color = nextColor(root);
        } else {
            delete node.side;
            delete node.color;
        }
        if (newParent.task) walk(node, n => { n.task ??= 'open'; });
        select(id);
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
    if (el) {
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
        select(id);
        drag = { ...base, kind: 'node', id, movable: Boolean(index.get(id).parent), started: false };
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
        drag.subtree = subtreeIds(index.get(drag.id).node);
        for (const id of drag.subtree) nodeEl(id)?.classList.add('drag-source');
        drag.ghost = document.createElement('div');
        drag.ghost.className = 'drag-ghost';
        drag.ghost.textContent = index.get(drag.id).node.text || ' ';
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
    if (!current.started) return;
    current.ghost.remove();
    showDrop(null);
    for (const id of current.subtree) nodeEl(id)?.classList.remove('drag-source');
    if (!cancelled && current.drop) moveNode(current.id, current.drop);
    else updateNodeBar();
}
window.addEventListener('pointerup', event => endDrag(event, false));
window.addEventListener('pointercancel', event => endDrag(event, true));
canvas.addEventListener('auxclick', event => event.preventDefault());

canvas.addEventListener('dblclick', event => {
    const el = event.target.closest('.node');
    if (el && !event.target.closest('[data-act]') && editing?.id !== el.dataset.id) startEdit(el.dataset.id);
});

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
    state.maps = state.maps.filter(m => !checked.has(m.id));
    for (const id of checked) histories.delete(id);
    checked.clear();
    selectMode = false;
    if (!state.maps.length) state.maps.push(createMap());
    if (!activeMap()) openMap(state.maps[0].id);
    saveNow();
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
    child: () => addChild(),
    sibling: () => addSibling('after'),
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
    if (editing || event.isComposing) return;
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
        ['全选', `${MOD}A`],
        ['调整顺序', `${MOD}↑ / ${MOD}↓`],
        ['删除所选节点', 'Delete'],
        ['折叠 / 展开', '⌥ .'],
        ['添加 / 移除待办', '⌥ T'],
        ['完成待办', '⌥ C'],
        ['备注', '⌥ N'],
        ['专注模式', '⌥ F'],
        ['渐隐模式', '⌥ G'],
        ['截止日期（标题末尾）', '11-20 / 11-20 23:00'],
        ['等待中（标题开头）', '=== QA testing'],
        ['撤销 / 重做', `${MOD}Z / ⇧${MOD}Z`],
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
    }
}

/* ---------- Start ---------- */

load();
renderHelp();
syncViewButtons();
render();
fit();
addEventListener('resize', () => applyView());
