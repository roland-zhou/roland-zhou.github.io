// Pure data helpers for MyMind: tree model, layout and OPML.

export const PALETTE_SIZE = 6;
const NS = 'https://rolandzhou.xyz/tools/mymind/';

export function uid() {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export function createNode(text = '', extra = {}) {
    return { id: uid(), text, note: '', task: null, children: [], ...extra };
}

export function createMap(title = '中心主题') {
    const now = Date.now();
    return { id: uid(), root: createNode(title), created: now, updated: now };
}

export function isValidMap(map) {
    const validNode = n => n && typeof n.id === 'string' && typeof n.text === 'string' && Array.isArray(n.children) && n.children.every(validNode);
    return map && typeof map.id === 'string' && validNode(map.root);
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
