import {
    MyListStore,
    toDateStr,
    parseDue,
    expandQuickDue,
    stripDue,
    dueDate,
    dueDayLabel,
    dueStatus,
    isFutureDue,
} from './model.js';

const store = new MyListStore();

// DOM references
const $ = (sel) => document.querySelector(sel);
const stageWrap = $('#stage-wrap');
const stage = $('#stage');
const canvasFlow = $('#canvas-flow');
const midDivider = $('#mid-divider');

const somedayList = $('#someday-list');
const scheduledList = $('#scheduled-list');
const nowList = $('#now-list');

const somedayEmpty = $('#someday-empty');
const scheduledEmpty = $('#scheduled-empty');
const nowEmpty = $('#now-empty');
const btnLoadSample = $('#btn-load-sample');

const somedayCount = $('#someday-count');
const scheduledCount = $('#scheduled-count');
const nowCount = $('#now-count');
const doneCount = $('#done-count');

const btnUndo = $('#btn-undo');
const btnDone = $('#btn-done');
const btnMore = $('#btn-more');
const moreMenu = $('#more-menu');

const composerForm = $('#composer-form');
const composerInput = $('#composer-input');
const composerDuePreview = $('#composer-due-preview');
const btnComposerAdd = $('#btn-composer-add');

const dropIndicator = $('#drop-indicator');

// Edit sheet
const editSheet = $('#edit-sheet');
const editText = $('#edit-text');
const editNote = $('#edit-note');
const editDuePreview = $('#edit-due-preview');
const editDateDest = $('#edit-date-dest');
const editZoneSwitch = $('#edit-zone-switch');
const editDeleteBtn = $('#edit-delete');
const editSaveBtn = $('#edit-save');

// Done sheet
const doneSheet = $('#done-sheet');
const doneListEl = $('#done-list');
const doneEmpty = $('#done-empty');
const btnClearDone = $('#btn-clear-done');

// Help sheet
const helpSheet = $('#help-sheet');

// Toast & file input
const toastEl = $('#toast');
const toastMsg = $('#toast-msg');
const toastAction = $('#toast-action');
const fileInput = $('#file-input');

// Local UI state
let editingId = null;
let editDraftZone = 'now';
let toastTimer = null;
let toastCallback = null;
let isInitialRender = true;
let suppressedClickUntil = 0;

// =========================================================================
// Viewport, Virtual Keyboard Pinning & Pinch-Zoom Prevention
// =========================================================================

let lastStageWidth = 0;
let isKeyboardOpen = false;
let baseViewportHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;

function syncViewport() {
    const vv = window.visualViewport;
    const h = vv ? vv.height : window.innerHeight;
    const top = vv ? vv.offsetTop : 0;

    // Track full-height baseline when keyboard is not open (or orientation changed)
    if (h > baseViewportHeight || Math.abs(window.innerWidth - lastStageWidth) > 80) {
        baseViewportHeight = h;
    }

    const kbNow = window.innerWidth < 640 && (baseViewportHeight - h > 110 || (window.innerHeight - h > 110));
    isKeyboardOpen = kbNow;

    document.documentElement.style.setProperty('--vv-h', `${Math.round(h)}px`);
    document.documentElement.style.setProperty('--vv-top', `${Math.max(0, Math.round(top))}px`);
    document.documentElement.classList.toggle('kb-open', kbNow);

    // Keep bottom composer and newest Now items anchored cleanly above the keyboard
    if (kbNow && document.activeElement === composerInput) {
        stage.scrollTop = stage.scrollHeight;
    }
}

if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewport);
    window.visualViewport.addEventListener('scroll', syncViewport);
}
window.addEventListener('resize', () => {
    baseViewportHeight = Math.max(baseViewportHeight, window.innerHeight);
    syncViewport();
});
window.addEventListener('orientationchange', () => {
    setTimeout(() => {
        baseViewportHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        syncViewport();
        updateZoneSizes(true);
    }, 150);
});

// Re-sync around iOS keyboard open/close animation frames
for (const field of [composerInput, editText, editNote]) {
    field.addEventListener('focus', () => {
        syncViewport();
        setTimeout(syncViewport, 80);
        setTimeout(syncViewport, 280);
    });
    field.addEventListener('blur', () => {
        setTimeout(() => {
            window.scrollTo(0, 0);
            syncViewport();
        }, 60);
        setTimeout(() => {
            window.scrollTo(0, 0);
            syncViewport();
        }, 280);
    });
}

// Prevent two-finger pinch zoom on mobile (including iOS Safari gesture events)
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener('touchstart', (e) => {
    if (e.touches.length > 1) e.preventDefault();
}, { passive: false });
document.addEventListener('touchmove', (e) => {
    if (e.touches.length > 1) e.preventDefault();
}, { passive: false });

syncViewport();

function updateZoneSizes(force = false) {
    const h = stage.clientHeight;
    const w = stage.clientWidth;
    if (h <= 0) return;
    // Do not squash 1/4 + 1/4 + 1/2 min-heights while the mobile virtual keyboard is open
    if (!force && isKeyboardOpen && w === lastStageWidth) return;
    lastStageWidth = w;
    const MID_H = 28;
    const WEAK_H = 24;
    const half = Math.max(160, (h - MID_H) / 2);
    const quarter = Math.max(80, (half - WEAK_H) / 2);
    stage.style.setProperty('--half-h', `${half}px`);
    stage.style.setProperty('--quarter-h', `${quarter}px`);
}

const stageRO = new ResizeObserver(() => {
    const wasAtBottom = (stage.scrollHeight - stage.clientHeight - stage.scrollTop) <= 16;
    updateZoneSizes();
    if (wasAtBottom) stage.scrollTop = stage.scrollHeight;
});
stageRO.observe(stage);

// =========================================================================
// MyMind-style Due Badge Painting
// =========================================================================

const clamp01 = x => Math.min(1, Math.max(0, x));
const pad2 = n => String(n).padStart(2, '0');

function paintDue(badge, due, { done = false, now = new Date() } = {}) {
    const { state, days, hours } = dueStatus(due, now);
    const date = dueDate(due, now);
    const label = dueDayLabel(date, now);
    const time = due.timed ? ` ${pad2(due.hour)}:${pad2(due.minute)}` : '';
    const md = `${pad2(due.month)}.${pad2(due.day)}`;

    badge.textContent = (label ?? md) + time;
    const exact = `${md} 周${'日一二三四五六'[date.getDay()]}${time}`;

    let strength = 1;
    if (state === 'overdue') strength = 1 - 0.85 * clamp01((days - 7) / 23);
    else if (state === 'upcoming') strength = 1 - clamp01((days - 3) / 11);
    if (done) strength = 0;

    badge.dataset.state = state;
    badge.classList.toggle('pale', strength < 0.7);
    badge.style.setProperty('--due-mix', `${Math.round(strength * 100)}%`);
    const status = done
        ? '已完成'
        : state === 'today'
            ? '今天到期'
            : state === 'overdue'
                ? (days ? `已过期 ${days} 天` : hours ? `已过期 ${hours} 小时` : '刚刚过期')
                : `还有 ${days} 天`;
    badge.title = `${exact} · ${status}`;
    return badge.textContent;
}

// =========================================================================
// Toast Notifications
// =========================================================================

function showToast(message, actionLabel = null, onAction = null, duration = 3200) {
    clearTimeout(toastTimer);
    toastMsg.textContent = message;
    if (actionLabel && onAction) {
        toastAction.textContent = actionLabel;
        toastAction.hidden = false;
        toastCallback = onAction;
    } else {
        toastAction.hidden = true;
        toastCallback = null;
    }
    toastEl.hidden = false;
    toastTimer = setTimeout(() => {
        toastEl.hidden = true;
        toastCallback = null;
    }, duration);
}

toastAction.addEventListener('click', () => {
    const fn = toastCallback;
    clearTimeout(toastTimer);
    toastEl.hidden = true;
    toastCallback = null;
    if (fn) fn();
});

// =========================================================================
// Rendering
// =========================================================================

function createTaskElement(item, now) {
    const li = document.createElement('li');
    const isScheduled = item.zone === 'scheduled';
    li.className = `task-item ${isScheduled ? 'is-scheduled' : 'is-draggable'}`;
    li.dataset.id = item.id;
    li.dataset.zone = item.zone;

    // Checkbox
    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'task-check';
    check.setAttribute('aria-label', '标记完成');
    check.innerHTML = '<svg><use href="#i-check"/></svg>';
    check.addEventListener('click', (e) => {
        e.stopPropagation();
        completeWithAnimation(item.id, li);
    });
    li.appendChild(check);

    // Body (clean title + due badge / desktop hover actions)
    const body = document.createElement('div');
    body.className = 'task-body';

    const due = parseDue(item.text);
    const displayText = due ? stripDue(item.text) : item.text;

    const textEl = document.createElement('span');
    textEl.className = 'task-text';
    textEl.textContent = displayText || item.text;
    body.appendChild(textEl);

    const meta = document.createElement('div');
    meta.className = 'task-meta';

    // Desktop hover quick actions
    const quick = document.createElement('div');
    quick.className = 'task-quick-actions';

    if (item.zone === 'now') {
        const upBtn = document.createElement('button');
        upBtn.type = 'button';
        upBtn.className = 'task-mini-btn';
        upBtn.title = '飞到最上面（以后再做）';
        upBtn.setAttribute('aria-label', '移到以后再做');
        upBtn.innerHTML = '<svg><use href="#i-arrow-up"/></svg>';
        upBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            flyItemToSomeday(item.id, li);
        });
        quick.appendChild(upBtn);
    } else if (item.zone === 'someday') {
        const downBtn = document.createElement('button');
        downBtn.type = 'button';
        downBtn.className = 'task-mini-btn';
        downBtn.title = '移到「现在」';
        downBtn.setAttribute('aria-label', '移到现在');
        downBtn.innerHTML = '<svg><use href="#i-arrow-down"/></svg>';
        downBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            store.moveItem(item.id, 'now', null);
            showToast('已移到「现在」', '撤销', () => store.undo());
        });
        quick.appendChild(downBtn);
    }

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'task-mini-btn danger';
    delBtn.title = '删除';
    delBtn.setAttribute('aria-label', '删除任务');
    delBtn.innerHTML = '<svg><use href="#i-trash"/></svg>';
    delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        store.deleteTask(item.id);
        showToast('已删除', '撤销', () => store.undo());
    });
    quick.appendChild(delBtn);
    meta.appendChild(quick);

    // Note presence indicator (only shown when item has a non-empty note)
    if (item.note) {
        const noteBtn = document.createElement('button');
        noteBtn.type = 'button';
        noteBtn.className = 'note-indicator';
        noteBtn.title = item.note;
        noteBtn.setAttribute('aria-label', '查看或编辑备注');
        noteBtn.innerHTML = '<svg><use href="#i-note"/></svg>';
        noteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openEditSheet(item.id, { focusNote: true });
        });
        meta.appendChild(noteBtn);
    }

    // MyMind-style Due Badge (shown on both Scheduled future items and Now today/overdue items)
    if (due) {
        const badge = document.createElement('span');
        badge.className = 'due';
        badge._due = due;
        paintDue(badge, due, { done: false, now });
        meta.appendChild(badge);
    }

    body.appendChild(meta);
    li.appendChild(body);

    // Drag grip ONLY for non-scheduled items (Now & Someday)
    if (!isScheduled) {
        const grip = document.createElement('span');
        grip.className = 'task-grip';
        grip.title = item.zone === 'now'
            ? '拖动排序 · 往上拖过中线飞到「以后再做」'
            : '拖动排序 · 往下拖过中线移到「现在」';
        grip.innerHTML = '<svg><use href="#i-grip"/></svg>';
        li.appendChild(grip);
    }

    // Tap/click opens edit sheet (unless right after drag)
    li.addEventListener('click', (e) => {
        if (Date.now() < suppressedClickUntil) return;
        if (e.target.closest('button')) return;
        openEditSheet(item.id);
    });

    return li;
}

function renderList(container, items, now) {
    const frag = document.createDocumentFragment();
    for (const item of items) {
        frag.appendChild(createTaskElement(item, now));
    }
    container.replaceChildren(frag);
}

function render(meta = {}) {
    const now = new Date();
    const somedayItems = store.getSomedayItems();
    const scheduledItems = store.getScheduledItems(now);
    const nowItems = store.getNowItems();
    const doneItems = store.getDoneItems();

    const prevScrollHeight = stage.scrollHeight;
    const prevScrollTop = stage.scrollTop;
    const wasAtBottom = (prevScrollHeight - stage.clientHeight - prevScrollTop) <= 16;

    renderList(somedayList, somedayItems, now);
    renderList(scheduledList, scheduledItems, now);
    renderList(nowList, nowItems, now);

    // Empty hints
    somedayEmpty.hidden = somedayItems.length > 0;
    scheduledEmpty.hidden = scheduledItems.length > 0;
    nowEmpty.hidden = nowItems.length > 0;

    // Sample button only when all active lists are empty
    const totalActive = somedayItems.length + scheduledItems.length + nowItems.length;
    btnLoadSample.hidden = totalActive > 0;

    // Counts
    somedayCount.textContent = somedayItems.length ? `${somedayItems.length}` : '';
    scheduledCount.textContent = scheduledItems.length ? `${scheduledItems.length}` : '';
    nowCount.textContent = nowItems.length ? `${nowItems.length}` : '';

    doneCount.textContent = String(doneItems.length);
    doneCount.hidden = doneItems.length === 0;
    btnUndo.disabled = !store.canUndo();

    if (!doneSheet.hidden) renderDoneList(doneItems);

    // Unified single-scroll anchoring & micro-animations
    if (isInitialRender || meta.type === 'sample' || meta.type === 'import') {
        isInitialRender = false;
        requestAnimationFrame(() => {
            updateZoneSizes();
            stage.scrollTop = stage.scrollHeight;
        });
    } else if (meta.type === 'add') {
        const el = document.querySelector(`.task-item[data-id="${CSS.escape(meta.id)}"]`);
        if (meta.zone === 'now') {
            if (el) el.classList.add('just-added');
            requestAnimationFrame(() => {
                stage.scrollTo({ top: stage.scrollHeight, behavior: 'smooth' });
            });
        } else if (meta.zone === 'scheduled' && el) {
            if (wasAtBottom) stage.scrollTop = stage.scrollHeight;
            el.classList.add('scheduled-pulse');
            requestAnimationFrame(() => {
                el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            });
        }
    } else if (meta.type === 'update' && meta.zone === 'scheduled') {
        const el = document.querySelector(`.task-item[data-id="${CSS.escape(meta.id)}"]`);
        if (wasAtBottom) stage.scrollTop = stage.scrollHeight;
        if (el) {
            el.classList.add('scheduled-pulse');
            requestAnimationFrame(() => {
                el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            });
        }
    } else if (meta.type === 'due-arrived') {
        for (const id of meta.ids || []) {
            const el = nowList.querySelector(`.task-item[data-id="${CSS.escape(id)}"]`);
            if (el) el.classList.add('just-added');
        }
        if (wasAtBottom) {
            requestAnimationFrame(() => {
                stage.scrollTo({ top: stage.scrollHeight, behavior: 'smooth' });
            });
        }
    } else if (meta.type === 'move' && meta.zone === 'now' && meta.prevZone === 'someday') {
        requestAnimationFrame(() => {
            stage.scrollTo({ top: stage.scrollHeight, behavior: 'smooth' });
        });
    } else {
        if (wasAtBottom) {
            stage.scrollTop = stage.scrollHeight;
        } else if (meta.type === 'move' && meta.zone === 'someday') {
            // Keep viewport visually steady if an item grew Someday above the current scroll position
            const delta = stage.scrollHeight - prevScrollHeight;
            if (delta > 0) stage.scrollTop = prevScrollTop + delta;
        }
    }
}

store.subscribe(render);

// =========================================================================
// Completion with smooth exit
// =========================================================================

function completeWithAnimation(id, li) {
    if (li.classList.contains('is-completing')) return;
    li.classList.add('is-completing');
    setTimeout(() => {
        store.toggleDone(id);
        showToast('已完成', '撤销', () => store.undo());
    }, 200);
}

// =========================================================================
// Fly-to-Top Animation (from Now -> Top of Someday)
// =========================================================================

function flyItemToSomeday(id, sourceEl) {
    const startRect = sourceEl.getBoundingClientRect();
    const ghost = sourceEl.cloneNode(true);
    ghost.classList.add('drag-ghost', 'is-flying-ready');
    ghost.style.width = `${startRect.width}px`;
    ghost.style.left = `${startRect.left}px`;
    ghost.style.top = `${startRect.top}px`;
    document.body.appendChild(ghost);

    store.moveItem(id, 'someday', null);
    animateGhostToSomeday(ghost, startRect, id);
}

function animateGhostToSomeday(ghost, fromRect, id) {
    const targetEl = somedayList.querySelector(`.task-item[data-id="${CSS.escape(id)}"]`);
    const stageRect = stage.getBoundingClientRect();

    let destLeft = fromRect.left;
    let destTop = stageRect.top + 10;
    let destScale = 0.96;
    let targetAboveFold = false;

    if (targetEl) {
        targetEl.style.opacity = '0';
        const tRect = targetEl.getBoundingClientRect();
        if (tRect.bottom >= stageRect.top && tRect.top <= stageRect.bottom) {
            destLeft = tRect.left;
            destTop = tRect.top;
            destScale = 1;
        } else {
            destLeft = tRect.left;
            destTop = stageRect.top - 8;
            destScale = 0.9;
            targetAboveFold = true;
        }
    }

    const dx = destLeft - fromRect.left;
    const dy = destTop - fromRect.top;

    const anim = ghost.animate([
        { transform: 'translate(0px, 0px) scale(1)', opacity: 1 },
        { transform: `translate(${dx}px, ${dy}px) scale(${destScale})`, opacity: targetAboveFold ? 0.15 : 1 },
    ], {
        duration: 360,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        fill: 'forwards',
    });

    anim.onfinish = () => {
        ghost.remove();
        if (targetEl) {
            targetEl.style.opacity = '';
            targetEl.classList.add('just-landed');
        }
        if (targetAboveFold) {
            showToast('已放入「以后再做」', '查看', () => {
                const el = somedayList.querySelector(`.task-item[data-id="${CSS.escape(id)}"]`);
                if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
                else stage.scrollTo({ top: 0, behavior: 'smooth' });
            }, 3800);
        } else {
            showToast('已放入「以后再做」', '撤销', () => store.undo());
        }
    };
}

// =========================================================================
// Pointer Drag & Drop (Unified Single-Scroll + Long-Press Touch + Fly-to-Top)
// =========================================================================

let drag = null;
let autoScrollRaf = null;

function stopAutoScroll() {
    if (autoScrollRaf) {
        cancelAnimationFrame(autoScrollRaf);
        autoScrollRaf = null;
    }
}

function getListDropTarget(listEl, clientY, draggingId) {
    const items = [...listEl.querySelectorAll('.task-item')].filter(el => el.dataset.id !== draggingId);
    const flowRect = canvasFlow.getBoundingClientRect();

    if (items.length === 0) {
        const listRect = listEl.getBoundingClientRect();
        return {
            index: 0,
            indicatorY: listRect.top - flowRect.top + Math.min(listRect.height, 8),
        };
    }

    for (let i = 0; i < items.length; i++) {
        const r = items[i].getBoundingClientRect();
        const mid = r.top + r.height / 2;
        if (clientY < mid) {
            return {
                index: i,
                indicatorY: r.top - flowRect.top - 4,
            };
        }
    }

    const lastRect = items[items.length - 1].getBoundingClientRect();
    return {
        index: items.length,
        indicatorY: lastRect.bottom - flowRect.top + 3,
    };
}

function activateDrag(state) {
    if (!state || state.active) return;
    state.active = true;
    clearTimeout(state.longPressTimer);

    if (state.pointerType === 'touch' && navigator.vibrate) {
        try { navigator.vibrate(12); } catch { /* ignore */ }
    }

    const rect = state.sourceEl.getBoundingClientRect();
    state.rect = rect;
    state.offsetX = state.curX - rect.left;
    state.offsetY = state.curY - rect.top;

    const ghost = state.sourceEl.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.style.width = `${rect.width}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    ghost.style.transform = 'scale(1.025)';
    document.body.appendChild(ghost);
    state.ghost = ghost;

    state.sourceEl.classList.add('is-drag-source');
    document.body.style.userSelect = 'none';

    updateDragPosition(state);
    startAutoScroll();
}

function startAutoScroll() {
    stopAutoScroll();
    const tick = () => {
        if (!drag || !drag.active) return;
        const y = drag.curY;
        const r = stage.getBoundingClientRect();
        const edge = 48;

        if (y < r.top + edge && y > r.top - 30) {
            // Do not auto-scroll endlessly upward once fly-someday is already triggered
            if (drag.mode !== 'fly-someday') {
                stage.scrollTop -= Math.ceil((r.top + edge - y) / 5);
                updateDragPosition(drag);
            }
        } else if (y > r.bottom - edge && y < r.bottom + 30) {
            stage.scrollTop += Math.ceil((y - (r.bottom - edge)) / 5);
            updateDragPosition(drag);
        }
        autoScrollRaf = requestAnimationFrame(tick);
    };
    autoScrollRaf = requestAnimationFrame(tick);
}

function updateDragPosition(state) {
    const left = state.rect.left + (state.curX - state.startX) * 0.18;
    const top = state.curY - state.offsetY;
    state.ghost.style.left = `${left}px`;
    state.ghost.style.top = `${top}px`;

    const divRect = midDivider.getBoundingClientRect();
    const midY = divRect.top + divRect.height / 2;

    stageWrap.classList.remove('drag-fly-someday', 'drag-drop-now');
    state.ghost.classList.remove('is-flying-ready');

    if (state.originZone === 'now') {
        if (state.curY < midY) {
            state.mode = 'fly-someday';
            state.targetZone = 'someday';
            state.targetIndex = null;
            stageWrap.classList.add('drag-fly-someday');
            state.ghost.classList.add('is-flying-ready');
            state.ghost.style.transform = 'scale(0.95)';
            dropIndicator.hidden = true;
        } else {
            state.mode = 'now-reorder';
            state.targetZone = 'now';
            state.ghost.style.transform = 'scale(1.025)';
            const target = getListDropTarget(nowList, state.curY, state.id);
            state.targetIndex = target.index;
            dropIndicator.style.top = `${target.indicatorY}px`;
            dropIndicator.hidden = false;
        }
    } else if (state.originZone === 'someday') {
        if (state.curY > midY) {
            state.mode = 'drop-now';
            state.targetZone = 'now';
            stageWrap.classList.add('drag-drop-now');
            state.ghost.style.transform = 'scale(1.02)';
            const target = getListDropTarget(nowList, state.curY, state.id);
            state.targetIndex = target.index;
            dropIndicator.style.top = `${target.indicatorY}px`;
            dropIndicator.hidden = false;
        } else {
            state.mode = 'someday-reorder';
            state.targetZone = 'someday';
            state.ghost.style.transform = 'scale(1.025)';
            const target = getListDropTarget(somedayList, state.curY, state.id);
            state.targetIndex = target.index;
            dropIndicator.style.top = `${target.indicatorY}px`;
            dropIndicator.hidden = false;
        }
    }
}

function cleanupDrag(commit = false) {
    if (!drag) return;
    const state = drag;
    drag = null;

    clearTimeout(state.longPressTimer);
    stopAutoScroll();
    stageWrap.classList.remove('drag-fly-someday', 'drag-drop-now');
    dropIndicator.hidden = true;
    document.body.style.userSelect = '';

    if (!state.active) return;

    suppressedClickUntil = Date.now() + 250;
    state.sourceEl.classList.remove('is-drag-source');

    if (!commit) {
        state.ghost?.remove();
        return;
    }

    const ghost = state.ghost;
    const ghostRect = ghost.getBoundingClientRect();

    if (state.mode === 'fly-someday') {
        ghost.style.transform = 'scale(1)';
        ghost.style.left = `${ghostRect.left}px`;
        ghost.style.top = `${ghostRect.top}px`;
        store.moveItem(state.id, 'someday', null);
        animateGhostToSomeday(ghost, ghostRect, state.id);
        return;
    }

    const moved = store.moveItem(state.id, state.targetZone, state.targetIndex);
    if (moved && state.mode === 'drop-now') {
        showToast('已移到「现在」', '撤销', () => store.undo());
    }

    const targetList = state.targetZone === 'now' ? nowList : somedayList;
    const landedEl = targetList.querySelector(`.task-item[data-id="${CSS.escape(state.id)}"]`);
    if (landedEl) {
        landedEl.style.opacity = '0';
        const dest = landedEl.getBoundingClientRect();
        const dx = dest.left - ghostRect.left;
        const dy = dest.top - ghostRect.top;
        ghost.style.transform = 'scale(1)';
        ghost.style.left = `${ghostRect.left}px`;
        ghost.style.top = `${ghostRect.top}px`;
        const anim = ghost.animate([
            { transform: 'translate(0px, 0px) scale(1.02)' },
            { transform: `translate(${dx}px, ${dy}px) scale(1)` },
        ], {
            duration: 160,
            easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
            fill: 'forwards',
        });
        anim.onfinish = () => {
            ghost.remove();
            landedEl.style.opacity = '';
        };
    } else {
        ghost.remove();
    }
}

stage.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    if (e.target.closest('button')) return;

    const itemEl = e.target.closest('.task-item.is-draggable');
    if (!itemEl) return;

    const id = itemEl.dataset.id;
    const originZone = itemEl.dataset.zone;
    const onGrip = Boolean(e.target.closest('.task-grip'));

    drag = {
        id,
        originZone,
        sourceEl: itemEl,
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        onGrip,
        startX: e.clientX,
        startY: e.clientY,
        curX: e.clientX,
        curY: e.clientY,
        active: false,
        mode: null,
        targetZone: originZone,
        targetIndex: 0,
        ghost: null,
        longPressTimer: null,
    };

    if (e.pointerType === 'touch') {
        const delay = onGrip ? 100 : 250;
        drag.longPressTimer = setTimeout(() => {
            if (drag && drag.pointerId === e.pointerId && !drag.active) {
                activateDrag(drag);
            }
        }, delay);
    }
});

window.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.curX = e.clientX;
    drag.curY = e.clientY;

    const dist = Math.hypot(drag.curX - drag.startX, drag.curY - drag.startY);

    if (!drag.active) {
        if (drag.pointerType === 'touch') {
            if (dist > 8) cleanupDrag(false);
        } else {
            const threshold = drag.onGrip ? 3 : 6;
            if (dist > threshold) activateDrag(drag);
        }
        return;
    }

    e.preventDefault();
    updateDragPosition(drag);
}, { passive: false });

window.addEventListener('touchmove', (e) => {
    if (drag && drag.active) e.preventDefault();
}, { passive: false });

window.addEventListener('pointerup', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    cleanupDrag(true);
});

window.addEventListener('pointercancel', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    cleanupDrag(false);
});

// =========================================================================
// Bottom Composer (Pure Text + Live Trailing Date Preview)
// =========================================================================

function syncComposerUI() {
    const raw = composerInput.value;
    const hasText = raw.trim().length > 0;
    btnComposerAdd.disabled = !hasText;

    const expanded = expandQuickDue(raw);
    const due = parseDue(expanded);
    if (due && stripDue(expanded).length > 0) {
        paintDue(composerDuePreview, due);
        composerDuePreview.hidden = false;
    } else {
        composerDuePreview.hidden = true;
    }
}

composerInput.addEventListener('input', syncComposerUI);

composerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = composerInput.value.trim();
    if (!raw) return;

    const item = store.addTask(raw);
    composerInput.value = '';
    syncComposerUI();
    composerInput.focus();

    if (item && item.zone === 'scheduled') {
        const due = parseDue(item.text);
        if (due) {
            const tmp = document.createElement('span');
            const label = paintDue(tmp, due);
            showToast(`已归入日程规划 · ${label}`);
        }
    }
});

// =========================================================================
// Task Edit Sheet (Raw Text Editing with Live Trailing-Date Detection)
// =========================================================================

function autoResizeTextarea(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
}

function syncEditSheetUI() {
    const expanded = expandQuickDue(editText.value);
    const due = parseDue(expanded);

    if (due) {
        paintDue(editDuePreview, due);
        editDuePreview.hidden = false;
        editDateDest.textContent = isFutureDue(due) ? '→ 日程规划' : '→ 现在';
        editDateDest.hidden = false;
        editZoneSwitch.hidden = true;
    } else {
        editDuePreview.hidden = true;
        editDateDest.hidden = true;
        editZoneSwitch.hidden = false;
        editZoneSwitch.querySelectorAll('[data-edit-zone]').forEach(btn => {
            btn.classList.toggle('is-active', btn.dataset.editZone === editDraftZone);
        });
    }
    autoResizeTextarea(editText);
    autoResizeTextarea(editNote);
}

function openEditSheet(id, { focusNote = false } = {}) {
    const item = store.getById(id);
    if (!item) return;
    editingId = id;
    editText.value = item.text;
    editNote.value = item.note || '';
    editDraftZone = item.zone === 'someday' ? 'someday' : 'now';
    closeMoreMenu();
    editSheet.hidden = false;
    syncEditSheetUI();
    requestAnimationFrame(() => {
        autoResizeTextarea(editText);
        autoResizeTextarea(editNote);
        const field = focusNote ? editNote : editText;
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
    });
}

function closeEditSheet() {
    editSheet.hidden = true;
    editingId = null;
}

editText.addEventListener('input', syncEditSheetUI);
editNote.addEventListener('input', () => autoResizeTextarea(editNote));

editZoneSwitch.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-edit-zone]');
    if (!btn) return;
    editDraftZone = btn.dataset.editZone;
    syncEditSheetUI();
});

function commitEdit() {
    if (!editingId) return;
    const raw = editText.value.trim();
    if (!raw) {
        editText.focus();
        return;
    }
    store.updateTask(editingId, {
        text: raw,
        note: editNote.value,
        zone: editDraftZone,
    });
    closeEditSheet();
}

editSaveBtn.addEventListener('click', commitEdit);

for (const field of [editText, editNote]) {
    field.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            commitEdit();
        }
    });
}

editDeleteBtn.addEventListener('click', () => {
    if (!editingId) return;
    const id = editingId;
    closeEditSheet();
    store.deleteTask(id);
    showToast('已删除', '撤销', () => store.undo());
});

// =========================================================================
// Completed Archive Sheet
// =========================================================================

function formatDoneTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const today = toDateStr();
    const ds = toDateStr(d);
    const hh = pad2(d.getHours());
    const mm = pad2(d.getMinutes());
    if (ds === today) return `今天 ${hh}:${mm}`;
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

function renderDoneList(items) {
    doneEmpty.hidden = items.length > 0;
    btnClearDone.hidden = items.length === 0;

    const frag = document.createDocumentFragment();
    for (const item of items) {
        const li = document.createElement('li');
        li.className = 'done-item';

        const check = document.createElement('button');
        check.type = 'button';
        check.className = 'done-check';
        check.title = '恢复待办';
        check.setAttribute('aria-label', '恢复待办');
        check.innerHTML = '<svg><use href="#i-check"/></svg>';
        check.addEventListener('click', () => {
            store.toggleDone(item.id);
            showToast('已恢复任务', '撤销', () => store.undo());
        });

        const info = document.createElement('div');
        info.className = 'done-info';
        const txt = document.createElement('span');
        txt.className = 'done-text';
        txt.textContent = item.text;
        const meta = document.createElement('span');
        meta.className = 'done-meta';
        const zoneLabel = item.zone === 'scheduled' ? '日程规划' : (item.zone === 'someday' ? '以后再做' : '现在');
        const noteTag = item.note ? ' · 含备注' : '';
        meta.textContent = `${zoneLabel}${noteTag} · ${formatDoneTime(item.doneAt)}`;
        if (item.note) meta.title = item.note;
        info.append(txt, meta);

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'task-mini-btn danger';
        del.title = '永久删除';
        del.setAttribute('aria-label', '永久删除');
        del.innerHTML = '<svg><use href="#i-trash"/></svg>';
        del.addEventListener('click', () => {
            store.deleteTask(item.id);
        });

        li.append(check, info, del);
        frag.appendChild(li);
    }
    doneListEl.replaceChildren(frag);
}

btnDone.addEventListener('click', () => {
    closeMoreMenu();
    renderDoneList(store.getDoneItems());
    doneSheet.hidden = false;
});

btnClearDone.addEventListener('click', () => {
    if (store.clearDone()) {
        showToast('已清空已完成列表', '撤销', () => store.undo());
    }
});

// =========================================================================
// Topbar, More Menu, Import / Export & Modals
// =========================================================================

function closeMoreMenu() {
    moreMenu.hidden = true;
    btnMore.setAttribute('aria-expanded', 'false');
}

btnUndo.addEventListener('click', () => {
    const label = store.undo();
    if (label) showToast(`已撤销：${label}`);
});

btnMore.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = moreMenu.hidden;
    closeMoreMenu();
    if (!opening) return;

    const rect = btnMore.getBoundingClientRect();
    moreMenu.style.top = `${Math.round(rect.bottom + 6)}px`;
    moreMenu.style.right = `${Math.max(10, Math.round(window.innerWidth - rect.right))}px`;
    moreMenu.hidden = false;
    btnMore.setAttribute('aria-expanded', 'true');
});

function downloadFile(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

moreMenu.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cmd]');
    if (!btn) return;
    const cmd = btn.dataset.cmd;
    closeMoreMenu();

    switch (cmd) {
        case 'help':
            helpSheet.hidden = false;
            break;
        case 'sample':
            store.loadSamples();
            showToast('已载入示例数据', '撤销', () => store.undo());
            break;
        case 'export-md':
            downloadFile(store.exportMarkdown(), `mylist-${toDateStr()}.md`, 'text/markdown;charset=utf-8');
            showToast('已导出 Markdown');
            break;
        case 'export-json':
            downloadFile(store.exportJSON(), `mylist-${toDateStr()}.json`, 'application/json;charset=utf-8');
            showToast('已导出 JSON 备份');
            break;
        case 'import-json':
            fileInput.value = '';
            fileInput.click();
            break;
    }
});

fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
        const text = await file.text();
        const count = store.importJSON(text);
        showToast(`已导入 ${count} 条任务`, '撤销', () => store.undo());
    } catch (err) {
        showToast(`导入失败：${err.message || '格式不正确'}`);
    }
});

btnLoadSample.addEventListener('click', () => {
    store.loadSamples();
    showToast('已载入示例，试试往上拖过中线！', '撤销', () => store.undo(), 4000);
});

// Close sheets / menu via backdrop or close button
document.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('[data-close-sheet]');
    if (closeBtn) {
        const sheet = document.getElementById(closeBtn.dataset.closeSheet);
        if (sheet) sheet.hidden = true;
        if (sheet === editSheet) editingId = null;
        return;
    }

    if (e.target.classList.contains('sheet-backdrop')) {
        e.target.hidden = true;
        if (e.target === editSheet) editingId = null;
        return;
    }

    if (!moreMenu.hidden && !e.target.closest('#more-menu') && !e.target.closest('#btn-more')) {
        closeMoreMenu();
    }
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    const inField = e.target.matches('input, textarea, [contenteditable="true"]');

    if (e.key === 'Escape') {
        if (!editSheet.hidden) closeEditSheet();
        else if (!doneSheet.hidden) doneSheet.hidden = true;
        else if (!helpSheet.hidden) helpSheet.hidden = true;
        else closeMoreMenu();
        return;
    }

    if (!inField && e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        composerInput.focus();
        return;
    }

    if (!inField && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        if (store.canUndo()) {
            e.preventDefault();
            const label = store.undo();
            if (label) showToast(`已撤销：${label}`);
        }
    }
});

// Check due rollovers & repaint due badges (midnight rollover + tab resume + timed overdue)
let lastDay = toDateStr();

function checkTimeTransitions() {
    const now = new Date();
    const today = toDateStr(now);
    const arrived = store.syncDueZones(now);
    if (arrived.length) {
        lastDay = today;
        showToast(arrived.length === 1 ? '有 1 项日程已到今天，已自动落入「现在」' : `有 ${arrived.length} 项日程已到今天，已自动落入「现在」`);
        return;
    }
    if (today !== lastDay) {
        lastDay = today;
        render();
        return;
    }
    for (const badge of stage.querySelectorAll('.due')) {
        if (badge._due) paintDue(badge, badge._due, { done: false, now });
    }
}

setInterval(checkTimeTransitions, 60000);
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkTimeTransitions();
});

// Initial render
syncComposerUI();
render();
