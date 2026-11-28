import {
    AI_PROVIDERS,
    AiwenjiStore,
    DEFAULT_SPLIT_PROMPT,
    MAX_QUICK_ACTIONS,
    PROVIDER_ORDER,
    RATINGS,
    REVIEW_CATEGORIES,
    ReviewQueue,
    SM2OSRScheduler,
    STORAGE_KEY,
    VERSION_KEY,
    applyFrontSuffix,
    clearAskDraft,
    compareVersions,
    exportApiTokens,
    getApiToken,
    getProvider,
    importApiTokens,
    isCardNew,
    loadAskDraft,
    mergeAiwenjiStates,
    resolveModel,
    saveAskDraft,
    setApiToken,
    toDateStr,
    uid,
} from './model.js?v=1';
import { CardSplitter, askAI, testAIConnection } from './ai.js?v=1';
import { markdownPlainText, renderMarkdown } from './markdown.js?v=1';
import { createCloudSync, formatSyncTime } from '../shared/cloud-sync.js?v=4';

// Release changelog (newest first). Prepend a new entry on each user-facing update;
// clients with an older stored version will see a one-line update toast on startup.
const RELEASES = [
    { version: '1.1.0', note: '翻译更精简，只给译文，每个说法配一个例句' },
    { version: '1.0.1', note: '更新 DeepSeek 模型列表' },
    { version: '1.0.0', note: '首个公开版本' },
];
const APP_VERSION = RELEASES[0].version;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const store = new AiwenjiStore();
let askDraft = loadAskDraft();

// Navigation state
// tab: 'ask' | 'review' | 'settings'
// subview: null | { type: 'cardList', category } | { type: 'study' } | { type: 'cardEditor', cardId, returnTo }
//          | { type: 'quickActionEditor', actionId } | { type: 'splitPromptEditor' }
let currentTab = 'ask';
let subview = null;

// Ask workbench transient state
let sendingConversationID = null;
let splittingConversationID = null;
let askError = '';
let inlineEditTarget = null; // { kind: 'message', convId, msgId, text } | { kind: 'candidate', convId, candId, side: 'front'|'back', text }

// Study session state
let studySession = null; // { queue: Card[], isAnswerRevealed: bool, completedCount: number }

// Settings transient state
let providerHighlightTimer = null;
let highlightProvider = false;
let testState = { status: 'untested', label: '未测试' }; // untested | testing | ok | err
let tokenVisible = false;

// Quick Ask (Card Editor modal) transient state
let quickAskState = null; // { input, exchanges: [{ id, messages }], sendingId, error, inlineEdit }

// Confirm dialog state
let confirmCallback = null;

// Toast state
let toastTimer = null;
let toastActionCb = null;

// DOM refs
const $ = (sel) => document.querySelector(sel);
const topbarEl = $('#topbar');
const mainViewEl = $('#main-view');
const bottomDockEl = $('#bottom-dock');
const quickAskSheet = $('#quick-ask-sheet');
const quickAskBody = $('#quick-ask-body');
const quickAskFooter = $('#quick-ask-footer');
const btnCloseQuickAsk = $('#btn-close-quick-ask');
const confirmModal = $('#confirm-modal');
const confirmTitle = $('#confirm-title');
const confirmDesc = $('#confirm-desc');
const confirmCancel = $('#confirm-cancel');
const confirmOk = $('#confirm-ok');
const toastEl = $('#toast');
const toastMsg = $('#toast-msg');
const toastAction = $('#toast-action');
const fileInput = $('#file-input');

/* ---------- Mobile VisualViewport & Pinch-Zoom Guard (Follows MyList) ---------- */

for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener('touchstart', (e) => {
    if (e.touches.length > 1) e.preventDefault();
}, { passive: false });

function syncViewport() {
    const vv = window.visualViewport;
    if (!vv || window.innerWidth >= 640) {
        document.documentElement.style.setProperty('--vv-h', '100dvh');
        document.documentElement.style.setProperty('--vv-top', '0px');
        document.documentElement.classList.remove('kb-open');
        return;
    }
    const h = Math.round(vv.height);
    const top = Math.max(0, Math.round(typeof vv.pageTop === 'number' ? vv.pageTop : (window.scrollY + vv.offsetTop)));
    document.documentElement.style.setProperty('--vv-h', `${h}px`);
    document.documentElement.style.setProperty('--vv-top', `${top}px`);
    document.documentElement.classList.toggle('kb-open', window.innerHeight - h > 110);
}

if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewport);
    window.visualViewport.addEventListener('scroll', syncViewport);
}
window.addEventListener('resize', syncViewport);
syncViewport();

/* ---------- Utilities ---------- */

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function showToast(msg, opts = {}) {
    clearTimeout(toastTimer);
    toastMsg.textContent = msg;
    if (opts.actionLabel && typeof opts.onAction === 'function') {
        toastAction.textContent = opts.actionLabel;
        toastAction.hidden = false;
        toastActionCb = opts.onAction;
    } else {
        toastAction.hidden = true;
        toastActionCb = null;
    }
    toastEl.hidden = false;
    toastTimer = setTimeout(() => {
        toastEl.hidden = true;
        toastActionCb = null;
    }, opts.duration || 2600);
}

toastAction.addEventListener('click', () => {
    const cb = toastActionCb;
    toastEl.hidden = true;
    toastActionCb = null;
    if (cb) cb();
});

async function copyText(str) {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(str);
            return true;
        }
    } catch { /* fallback */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = str;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        return true;
    } catch {
        return false;
    }
}

function showConfirm({ title, desc, okLabel = '删除', danger = true, onConfirm }) {
    confirmTitle.textContent = title;
    confirmDesc.textContent = desc || '';
    confirmOk.textContent = okLabel;
    confirmOk.className = `pill-btn ${danger ? 'danger-solid' : 'primary'}`;
    confirmCallback = onConfirm;
    confirmModal.hidden = false;
}

function closeConfirm() {
    confirmModal.hidden = true;
    confirmCallback = null;
}

confirmCancel.addEventListener('click', closeConfirm);
confirmModal.addEventListener('click', (e) => {
    if (e.target === confirmModal) closeConfirm();
});
confirmOk.addEventListener('click', () => {
    const cb = confirmCallback;
    closeConfirm();
    if (cb) cb();
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

function autoResizeTextarea(ta, maxPx = 132) {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(maxPx, Math.max(42, ta.scrollHeight))}px`;
}

function getLatestExchange(conv) {
    const msgs = conv?.messages || [];
    let answerIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'assistant') { answerIdx = i; break; }
    }
    if (answerIdx < 0) return null;
    let questionIdx = -1;
    for (let i = answerIdx - 1; i >= 0; i--) {
        if (msgs[i].role === 'user') { questionIdx = i; break; }
    }
    return {
        questionIdx,
        answerIdx,
        question: questionIdx >= 0 ? msgs[questionIdx].content : '',
        answer: msgs[answerIdx].content,
    };
}

function persistDraft() {
    saveAskDraft(askDraft);
}

function syncSavedCardToDraft(cardId, front, back) {
    let changed = false;
    for (const conv of askDraft.conversations) {
        if (conv.mainSavedCardID === cardId) {
            const ex = getLatestExchange(conv);
            if (ex) {
                if (ex.questionIdx >= 0) conv.messages[ex.questionIdx].content = front;
                conv.messages[ex.answerIdx].content = back;
                changed = true;
            }
        }
        for (const cand of conv.candidateCards || []) {
            if (cand.savedCardID === cardId) {
                cand.front = front;
                cand.back = back;
                changed = true;
            }
        }
    }
    if (changed) persistDraft();
}

function unlinkSavedCardInDraft(cardId) {
    let changed = false;
    for (const conv of askDraft.conversations) {
        if (conv.mainSavedCardID === cardId) {
            conv.mainSavedCardID = null;
            changed = true;
        }
        for (const cand of conv.candidateCards || []) {
            if (cand.savedCardID === cardId) {
                cand.savedCardID = null;
                changed = true;
            }
        }
    }
    if (changed) persistDraft();
}

/* ---------- Cloudflare Worker + D1 Cloud Sync (Follows MyMind & MyList) ---------- */

const SYNC_UI = {
    unconfigured: { icon: '#i-cloud', label: '', spin: false },
    synced: { icon: '#i-cloud-check', label: '已同步', spin: false },
    dirty: { icon: '#i-cloud-up', label: '待同步', spin: false },
    syncing: { icon: '#i-sync', label: '同步中', spin: true },
    error: { icon: '#i-cloud-alert', label: '失败', spin: false },
};

let lastSyncInfo = { state: 'unconfigured', configured: false, host: '', lastSyncAt: 0, lastError: '' };

const sync = createCloudSync({
    appId: 'aiwenji',
    appName: 'ai问记',
    autoSyncIntervalMs: 5 * 60 * 1000,
    getLocalData: () => store.getSyncSnapshot(),
    mergeData: (local, remote) => mergeAiwenjiStates(local, remote),
    applyMergedData: (merged) => store.applyRemoteState(merged),
    isBusy: () => Boolean(
        subview?.type === 'cardEditor' ||
        subview?.type === 'quickActionEditor' ||
        subview?.type === 'splitPromptEditor' ||
        inlineEditTarget ||
        !quickAskSheet.hidden
    ),
    getPairingExtras: () => exportApiTokens(),
    applyPairingExtras: (extras) => {
        if (importApiTokens(extras)) {
            showToast('已同步导入 AI API Token');
            render();
        }
    },
    onStatusChange: (info) => {
        lastSyncInfo = info;
        paintSyncButton();
        if (currentTab === 'settings' && !subview) {
            const el = $('#settings-sync-status');
            if (el) el.textContent = formatSettingsSyncSummary(info);
        }
    },
    onToast: (msg, opts) => showToast(msg, opts),
});

store.subscribe((meta) => {
    if (meta.type !== 'remote') {
        sync.markDirty();
    } else if (studySession) {
        // Refresh cards in active study session if updated remotely
        studySession.queue = studySession.queue
            .map(c => store.getCard(c.id))
            .filter(Boolean);
    }
    render();
});

function formatSettingsSyncSummary(info) {
    if (!info.configured) return '未配置（仅保存在本机浏览器）';
    const labels = { synced: '已同步', dirty: '有未同步改动', syncing: '同步中…', error: '同步失败' };
    const stateStr = labels[info.state] || info.state;
    return `${stateStr} · ${info.host} · ${formatSyncTime(info.lastSyncAt)}`;
}

function paintSyncButton() {
    const btn = $('#btn-sync');
    if (!btn) return;
    const cfg = SYNC_UI[lastSyncInfo.state] || SYNC_UI.unconfigured;
    btn.dataset.state = lastSyncInfo.state;
    btn.querySelector('use')?.setAttribute('href', cfg.icon);
    btn.querySelector('svg')?.classList.toggle('csync-spinning', cfg.spin);
    const lbl = btn.querySelector('.sync-btn-label');
    if (lbl) {
        lbl.textContent = cfg.label;
        lbl.hidden = !cfg.label;
    }
    const saveKey = isMac ? '⌘S' : 'Ctrl+S';
    if (!lastSyncInfo.configured) {
        btn.title = '配置 Cloudflare 云同步（可选）';
    } else if (lastSyncInfo.state === 'error') {
        btn.title = `同步失败：${lastSyncInfo.lastError || '网络错误'} · 点击重试`;
    } else if (lastSyncInfo.state === 'dirty') {
        btn.title = `有未同步改动 · 点击立即同步 (${saveKey})`;
    } else {
        btn.title = `已同步 (${formatSyncTime(lastSyncInfo.lastSyncAt)}) · 点击立即同步 (${saveKey})`;
    }
}

/* ---------- Navigation Helpers ---------- */

function switchTab(tab) {
    currentTab = tab;
    subview = null;
    inlineEditTarget = null;
    quickAskState = null;
    quickAskSheet.hidden = true;
    render();
    mainViewEl.scrollTop = 0;
}

function openCardEditor(cardId, returnTo) {
    if (!store.getCard(cardId)) return;
    subview = { type: 'cardEditor', cardId, returnTo };
    quickAskState = { input: '', exchanges: [], sendingId: null, error: '', inlineEdit: null };
    render();
    mainViewEl.scrollTop = 0;
}

function exitCardEditor() {
    const ret = subview?.returnTo || null;
    quickAskState = null;
    quickAskSheet.hidden = true;
    subview = ret;
    render();
}

function jumpToProviderSettings() {
    currentTab = 'settings';
    subview = null;
    highlightProvider = true;
    render();
    requestAnimationFrame(() => {
        const anchor = $('#settings-provider-anchor');
        if (anchor) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    clearTimeout(providerHighlightTimer);
    providerHighlightTimer = setTimeout(() => {
        highlightProvider = false;
        const card = $('.provider-card.highlighted');
        if (card) card.classList.remove('highlighted');
    }, 1300);
}

/* ---------- Ask Actions ---------- */

async function handleAskSubmit({ instruction = null, frontSuffix = null } = {}) {
    const text = (askDraft.input || '').trim();
    if (!text || sendingConversationID) return;

    const convId = uid();
    const userDisplay = applyFrontSuffix(text, frontSuffix) || text;
    const splitSuffix = frontSuffix?.appliesToSplitCards ? (frontSuffix.text || '') : '';
    const conv = {
        id: convId,
        messages: [{ id: uid(), role: 'user', content: userDisplay }],
        mainSavedCardID: null,
        splitCardSuffix: splitSuffix,
        candidateCards: [],
    };
    askDraft.conversations.push(conv);
    askDraft.input = '';
    sendingConversationID = convId;
    askError = '';
    persistDraft();
    render();
    scrollConversationIntoView(convId);

    try {
        const reply = await askAI({
            settings: store.settings,
            instruction,
            input: text,
        });
        const target = askDraft.conversations.find(c => c.id === convId);
        if (target) {
            target.messages.push({ id: uid(), role: 'assistant', content: reply });
        }
    } catch (err) {
        askError = err?.message || '请求失败，请稍后重试。';
    }

    sendingConversationID = null;
    persistDraft();
    render();
    scrollConversationIntoView(convId);
}

async function handleSplitConversation(convId) {
    if (sendingConversationID || splittingConversationID) return;
    const conv = askDraft.conversations.find(c => c.id === convId);
    const ex = getLatestExchange(conv);
    if (!conv || !ex) return;

    splittingConversationID = convId;
    askError = '';
    render();

    try {
        const instruction = CardSplitter.instruction(store.settings.splitPrompt);
        const input = CardSplitter.exchangeInput(ex.question, ex.answer);
        const reply = await askAI({
            settings: store.settings,
            instruction,
            input,
        });
        const parsed = CardSplitter.parse(reply).map(c => ({
            ...c,
            front: applyFrontSuffix(c.front, conv.splitCardSuffix) || c.front,
        }));
        if (!parsed.length) {
            askError = '这次没能拆出可用的卡片，可以再试一次。';
        } else {
            const target = askDraft.conversations.find(c => c.id === convId);
            if (target) target.candidateCards = parsed;
        }
    } catch (err) {
        askError = err?.message || '拆分失败，请稍后重试。';
    }

    splittingConversationID = null;
    persistDraft();
    render();
    scrollCandidateGroupIntoView(convId);
}

function handleAddMainCard(convId) {
    const conv = askDraft.conversations.find(c => c.id === convId);
    if (!conv || conv.mainSavedCardID) return;
    const ex = getLatestExchange(conv);
    if (!ex) return;
    const card = store.createCard({ front: ex.question, back: ex.answer, sourceType: 'ask' });
    if (!card) return;
    conv.mainSavedCardID = card.id;
    persistDraft();
    render();
    showToast('已加入卡片');
}

function handleAddCandidateCard(convId, candId) {
    const conv = askDraft.conversations.find(c => c.id === convId);
    const cand = conv?.candidateCards?.find(c => c.id === candId);
    if (!cand || cand.savedCardID) return;
    const card = store.createCard({ front: cand.front, back: cand.back, sourceType: 'split' });
    if (!card) return;
    cand.savedCardID = card.id;
    persistDraft();
    render();
    showToast('已加入卡片');
}

function handleDeleteConversation(convId) {
    askDraft.conversations = askDraft.conversations.filter(c => c.id !== convId);
    if (inlineEditTarget?.convId === convId) inlineEditTarget = null;
    persistDraft();
    render();
}

function handleDeleteCandidate(convId, candId) {
    const conv = askDraft.conversations.find(c => c.id === convId);
    if (!conv) return;
    conv.candidateCards = (conv.candidateCards || []).filter(c => c.id !== candId);
    if (inlineEditTarget?.candId === candId) inlineEditTarget = null;
    persistDraft();
    render();
}

function handleClearWorkbench() {
    askDraft = { input: '', conversations: [] };
    sendingConversationID = null;
    splittingConversationID = null;
    askError = '';
    inlineEditTarget = null;
    clearAskDraft();
    render();
}

function commitInlineEdit(newText) {
    const clean = String(newText || '').trim();
    if (!clean || !inlineEditTarget) return;

    if (inlineEditTarget.kind === 'message') {
        const conv = askDraft.conversations.find(c => c.id === inlineEditTarget.convId);
        const msg = conv?.messages?.find(m => m.id === inlineEditTarget.msgId);
        if (conv && msg) {
            msg.content = clean;
            if (conv.mainSavedCardID) {
                const ex = getLatestExchange(conv);
                if (ex) store.updateCard(conv.mainSavedCardID, { front: ex.question, back: ex.answer });
            }
            persistDraft();
        }
    } else if (inlineEditTarget.kind === 'candidate') {
        const conv = askDraft.conversations.find(c => c.id === inlineEditTarget.convId);
        const cand = conv?.candidateCards?.find(c => c.id === inlineEditTarget.candId);
        if (cand) {
            if (inlineEditTarget.side === 'front') cand.front = clean;
            else cand.back = clean;
            if (cand.savedCardID) {
                store.updateCard(cand.savedCardID, { front: cand.front, back: cand.back });
            }
            persistDraft();
        }
    }
    inlineEditTarget = null;
    render();
}

function scrollConversationIntoView(convId) {
    requestAnimationFrame(() => {
        const el = document.querySelector(`[data-conv-id="${CSS.escape(convId)}"]`);
        if (!el) return;
        const viewRect = mainViewEl.getBoundingClientRect();
        const cardRect = el.getBoundingClientRect();
        el.scrollIntoView({
            behavior: 'smooth',
            block: cardRect.height > viewRect.height - 24 ? 'start' : 'end',
        });
    });
}

function scrollCandidateGroupIntoView(convId) {
    requestAnimationFrame(() => {
        const el = document.querySelector(`[data-cand-group="${CSS.escape(convId)}"]`);
        if (!el) return;
        const viewRect = mainViewEl.getBoundingClientRect();
        const rect = el.getBoundingClientRect();
        el.scrollIntoView({
            behavior: 'smooth',
            block: rect.height > viewRect.height - 24 ? 'start' : 'end',
        });
    });
}

/* ---------- Study Session Actions ---------- */

function startStudySession() {
    const queue = ReviewQueue.todayQueue(store.cards);
    studySession = {
        queue: [...queue],
        isAnswerRevealed: false,
        completedCount: 0,
    };
    subview = { type: 'study' };
    render();
    mainViewEl.scrollTop = 0;
}

function revealStudyAnswer() {
    if (!studySession || studySession.isAnswerRevealed || !studySession.queue.length) return;
    studySession.isAnswerRevealed = true;
    render();
}

function rateCurrentStudyCard(rating) {
    if (!studySession || !studySession.isAnswerRevealed || !studySession.queue.length) return;
    const current = studySession.queue[0];
    const updated = store.rateCard(current.id, rating);
    studySession.queue.shift();
    if (rating === 'again' && updated) {
        studySession.queue.push(updated);
    } else {
        studySession.completedCount += 1;
    }
    studySession.isAnswerRevealed = false;
    render();
    mainViewEl.scrollTop = 0;
}

/* ---------- Quick Ask Modal (Card Editor Floating Ball) ---------- */

function openQuickAskModal() {
    if (!quickAskState) {
        quickAskState = { input: '', exchanges: [], sendingId: null, error: '', inlineEdit: null };
    }
    quickAskSheet.hidden = false;
    renderQuickAsk();
}

function closeQuickAskModal() {
    quickAskSheet.hidden = true;
}

btnCloseQuickAsk.addEventListener('click', closeQuickAskModal);
quickAskSheet.addEventListener('click', (e) => {
    if (e.target === quickAskSheet) closeQuickAskModal();
});

async function handleQuickAskSend({ instruction = null, frontSuffix = null } = {}) {
    if (!quickAskState || quickAskState.sendingId) return;
    const text = (quickAskState.input || '').trim();
    if (!text) return;

    const exId = uid();
    const userDisplay = applyFrontSuffix(text, frontSuffix) || text;
    quickAskState.exchanges.push({
        id: exId,
        messages: [{ id: uid(), role: 'user', content: userDisplay }],
    });
    quickAskState.input = '';
    quickAskState.sendingId = exId;
    quickAskState.error = '';
    renderQuickAsk();
    quickAskBody.scrollTop = quickAskBody.scrollHeight;

    try {
        const reply = await askAI({
            settings: store.settings,
            instruction,
            input: text,
        });
        const target = quickAskState?.exchanges.find(e => e.id === exId);
        if (target) {
            target.messages.push({ id: uid(), role: 'assistant', content: reply });
        }
    } catch (err) {
        if (quickAskState) quickAskState.error = err?.message || '请求失败，请稍后重试。';
    }

    if (quickAskState) {
        quickAskState.sendingId = null;
        renderQuickAsk();
        quickAskBody.scrollTop = quickAskBody.scrollHeight;
    }
}

function renderQuickAsk() {
    if (!quickAskState) return;
    const provider = getProvider(store.settings.provider);
    const hasToken = Boolean(getApiToken(provider.id));
    const actions = store.getSortedQuickActions();

    if (!quickAskState.exchanges.length) {
        quickAskBody.innerHTML = `
            <div class="empty-state-center" style="padding: 28px 16px;">
                <h2>随手问一句，不打断编辑</h2>
                <p>这里的问答只属于本次编辑，返回后不会留在「问」的工作台里。</p>
            </div>
        `;
    } else {
        quickAskBody.innerHTML = quickAskState.exchanges.map((ex) => {
            const isSending = quickAskState.sendingId === ex.id;
            const msgsHtml = ex.messages.map((m) => {
                if (quickAskState.inlineEdit?.msgId === m.id) {
                    return `
                        <div class="inline-editor">
                            <textarea data-qa-inline-text>${escapeHtml(quickAskState.inlineEdit.text)}</textarea>
                            <div class="inline-editor-actions">
                                <button type="button" class="pill-btn ghost sm" data-qa-inline-cancel>取消</button>
                                <button type="button" class="pill-btn primary sm" data-qa-inline-save>完成</button>
                            </div>
                        </div>
                    `;
                }
                return `
                    <div class="bubble ${m.role === 'user' ? 'user' : ''}">
                        <div class="md-content">${renderMarkdown(m.content)}</div>
                        <div class="bubble-tools">
                            <button type="button" class="bubble-tool-btn" data-qa-copy="${escapeHtml(m.id)}">
                                <svg><use href="#i-copy"/></svg>复制
                            </button>
                            <button type="button" class="bubble-tool-btn" data-qa-edit="${escapeHtml(m.id)}">
                                <svg><use href="#i-edit"/></svg>编辑
                            </button>
                        </div>
                    </div>
                `;
            }).join('');
            const loadingHtml = isSending ? `
                <div class="loading-bubble">
                    <div class="loading-label">AI 正在回复</div>
                    <div class="loading-dots"><i></i><i></i><i></i></div>
                </div>
            ` : '';
            return `<div class="conv-card">${msgsHtml}${loadingHtml}</div>`;
        }).join('');
    }

    const noticeHtml = !hasToken ? `
        <div class="notice-bar">
            <div class="notice-text">
                <div class="notice-title">还没填 ${escapeHtml(provider.displayName)} 的 API Token</div>
                <div class="notice-detail">去「设置 › AI 提供商」里填一下。</div>
            </div>
        </div>
    ` : (quickAskState.error ? `<div class="error-banner">${escapeHtml(quickAskState.error)}</div>` : '');

    quickAskFooter.innerHTML = `
        ${noticeHtml}
        <div class="composer-box">
            <textarea class="composer-textarea" id="qa-input" rows="1" placeholder="问点什么...">${escapeHtml(quickAskState.input)}</textarea>
            <div class="composer-bottom">
                <div class="chips-scroll">
                    ${actions.map((a, idx) => `
                        <button type="button" class="chip-btn" data-qa-action="${idx}" ${quickAskState.sendingId ? 'disabled' : ''}>${escapeHtml(a.title)}</button>
                    `).join('')}
                </div>
                <button type="button" class="pill-btn primary sm" id="btn-qa-send" ${quickAskState.sendingId ? 'disabled' : ''}>问 AI</button>
            </div>
        </div>
    `;

    const qaInput = $('#qa-input');
    autoResizeTextarea(qaInput, 110);
    qaInput.addEventListener('input', () => {
        quickAskState.input = qaInput.value;
        autoResizeTextarea(qaInput, 110);
    });
    qaInput.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            handleQuickAskSend();
        }
    });
    $('#btn-qa-send').addEventListener('click', () => handleQuickAskSend());
    quickAskFooter.querySelectorAll('[data-qa-action]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const action = actions[Number(btn.dataset.qaAction)];
            if (action) handleQuickAskSend({ instruction: action.prompt, frontSuffix: action.frontSuffix });
        });
    });

    quickAskBody.querySelectorAll('[data-qa-copy]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const msgId = btn.dataset.qaCopy;
            for (const ex of quickAskState.exchanges) {
                const m = ex.messages.find(x => x.id === msgId);
                if (m) {
                    await copyText(m.content);
                    showToast('已复制');
                    return;
                }
            }
        });
    });
    quickAskBody.querySelectorAll('[data-qa-edit]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const msgId = btn.dataset.qaEdit;
            for (const ex of quickAskState.exchanges) {
                const m = ex.messages.find(x => x.id === msgId);
                if (m) {
                    quickAskState.inlineEdit = { msgId: m.id, text: m.content };
                    renderQuickAsk();
                    return;
                }
            }
        });
    });
    const qaEditTa = quickAskBody.querySelector('[data-qa-inline-text]');
    if (qaEditTa) {
        qaEditTa.focus();
        quickAskBody.querySelector('[data-qa-inline-cancel]').addEventListener('click', () => {
            quickAskState.inlineEdit = null;
            renderQuickAsk();
        });
        quickAskBody.querySelector('[data-qa-inline-save]').addEventListener('click', () => {
            const val = qaEditTa.value.trim();
            if (!val) return;
            for (const ex of quickAskState.exchanges) {
                const m = ex.messages.find(x => x.id === quickAskState.inlineEdit.msgId);
                if (m) { m.content = val; break; }
            }
            quickAskState.inlineEdit = null;
            renderQuickAsk();
        });
    }
}

/* ---------- Rendering: Top Bar ---------- */

function renderRootTopbar() {
    const showClear = currentTab === 'ask' && askDraft.conversations.length > 0;
    topbarEl.innerHTML = `
        <nav class="nav-pill" aria-label="主导航">
            <button type="button" data-tab="ask" class="${currentTab === 'ask' ? 'active' : ''}">问</button>
            <button type="button" data-tab="review" class="${currentTab === 'review' ? 'active' : ''}">记</button>
            <button type="button" data-tab="settings" class="${currentTab === 'settings' ? 'active' : ''}">设置</button>
        </nav>
        <div class="topbar-right">
            ${showClear ? '<button type="button" class="pill-btn danger-ghost sm" id="btn-clear-ask">清除</button>' : ''}
            <button type="button" class="sync-btn" id="btn-sync" data-state="${lastSyncInfo.state}" aria-label="云同步">
                <svg><use href="#i-cloud"/></svg>
                <span class="sync-btn-label" hidden></span>
            </button>
        </div>
    `;

    topbarEl.querySelectorAll('[data-tab]').forEach((btn) => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
    const clearBtn = $('#btn-clear-ask');
    if (clearBtn) {
        clearBtn.addEventListener('click', handleClearWorkbench);
    }
    const syncBtn = $('#btn-sync');
    if (syncBtn) {
        paintSyncButton();
        syncBtn.addEventListener('click', () => {
            if (sync.isConfigured()) sync.syncNow({ manual: true });
            else sync.openSettings();
        });
    }
}

function renderFlowTopbar({ title, onBack, rightHtml = '<div class="flow-spacer"></div>', escHint = false }) {
    topbarEl.innerHTML = `
        <div class="flow-header">
            <button type="button" class="pill-btn ghost sm" id="btn-flow-back">
                ‹ 返回${escHint ? ' <span class="kbd-hint">(Esc)</span>' : ''}
            </button>
            <h2 class="flow-title">${escapeHtml(title)}</h2>
            <div>${rightHtml}</div>
        </div>
    `;
    $('#btn-flow-back').addEventListener('click', onBack);
}

/* ---------- Rendering: Ask Tab ---------- */

function renderBubbleHtml({ content, isUser, editKey, copyAttrs, editAttrs, isEditing }) {
    if (isEditing) {
        return `
            <div class="inline-editor">
                <textarea id="inline-edit-textarea">${escapeHtml(inlineEditTarget.text)}</textarea>
                <div class="inline-editor-actions">
                    <button type="button" class="pill-btn ghost sm" id="btn-inline-cancel">取消</button>
                    <button type="button" class="pill-btn primary sm" id="btn-inline-save">完成</button>
                </div>
            </div>
        `;
    }
    return `
        <div class="bubble ${isUser ? 'user' : ''}" data-bubble-key="${escapeHtml(editKey)}">
            <div class="md-content">${renderMarkdown(content)}</div>
            <div class="bubble-tools">
                <button type="button" class="bubble-tool-btn" ${copyAttrs}>
                    <svg><use href="#i-copy"/></svg>复制
                </button>
                <button type="button" class="bubble-tool-btn" ${editAttrs}>
                    <svg><use href="#i-edit"/></svg>编辑
                </button>
            </div>
        </div>
    `;
}

function renderAddCardActionHtml(savedCardID, { addAttrs, canAdd = true }) {
    if (savedCardID && store.getCard(savedCardID)) {
        return `
            <span class="added-badge"><svg><use href="#i-check-circle"/></svg>已加入</span>
            <button type="button" class="pill-btn primary sm" data-edit-saved-card="${escapeHtml(savedCardID)}">编辑卡片</button>
        `;
    }
    return `<button type="button" class="pill-btn primary sm" ${addAttrs} ${canAdd ? '' : 'disabled'}>加入卡片</button>`;
}

function renderAskView() {
    renderRootTopbar();
    const hasConvs = askDraft.conversations.length > 0;

    if (!hasConvs) {
        mainViewEl.innerHTML = `
            <div class="main-inner full-height">
                <div class="ask-empty">
                    <h1>把一个问题，变成方便记忆的小卡片</h1>
                    <p>输入问题，寻求答案。</p>
                </div>
            </div>
        `;
    } else {
        const threadHtml = askDraft.conversations.map((conv) => {
            const isSending = sendingConversationID === conv.id;
            const isSplitting = splittingConversationID === conv.id;
            const hasExchange = Boolean(getLatestExchange(conv));
            const canSplit = !sendingConversationID && !isSplitting && hasExchange;
            const canAdd = !sendingConversationID && hasExchange;

            const msgsHtml = conv.messages.map((msg) => {
                const isEditing = inlineEditTarget?.kind === 'message' && inlineEditTarget.msgId === msg.id;
                return renderBubbleHtml({
                    content: msg.content,
                    isUser: msg.role === 'user',
                    editKey: `msg:${msg.id}`,
                    copyAttrs: `data-copy-msg="${escapeHtml(conv.id)}|${escapeHtml(msg.id)}"`,
                    editAttrs: `data-edit-msg="${escapeHtml(conv.id)}|${escapeHtml(msg.id)}"`,
                    isEditing,
                });
            }).join('');

            const loadingHtml = isSending ? `
                <div class="loading-bubble">
                    <div class="loading-label">AI 正在回复</div>
                    <div class="loading-dots"><i></i><i></i><i></i></div>
                </div>
            ` : '';

            const cands = conv.candidateCards || [];
            const candGroupHtml = cands.length ? `
                <div class="candidate-group" data-cand-group="${escapeHtml(conv.id)}">
                    <div class="candidate-group-head">
                        <span class="candidate-group-label">
                            <svg><use href="#i-turn-down-right"/></svg>
                            这轮问答的拆分卡
                        </span>
                        <span>${cands.length} 张</span>
                    </div>
                    ${cands.map((cand) => {
                        const editingFront = inlineEditTarget?.kind === 'candidate' && inlineEditTarget.candId === cand.id && inlineEditTarget.side === 'front';
                        const editingBack = inlineEditTarget?.kind === 'candidate' && inlineEditTarget.candId === cand.id && inlineEditTarget.side === 'back';
                        return `
                            <div class="candidate-card">
                                ${renderBubbleHtml({
                                    content: cand.front,
                                    isUser: true,
                                    editKey: `cand:${cand.id}:front`,
                                    copyAttrs: `data-copy-cand="${escapeHtml(conv.id)}|${escapeHtml(cand.id)}|front"`,
                                    editAttrs: `data-edit-cand="${escapeHtml(conv.id)}|${escapeHtml(cand.id)}|front"`,
                                    isEditing: editingFront,
                                })}
                                ${renderBubbleHtml({
                                    content: cand.back,
                                    isUser: false,
                                    editKey: `cand:${cand.id}:back`,
                                    copyAttrs: `data-copy-cand="${escapeHtml(conv.id)}|${escapeHtml(cand.id)}|back"`,
                                    editAttrs: `data-edit-cand="${escapeHtml(conv.id)}|${escapeHtml(cand.id)}|back"`,
                                    isEditing: editingBack,
                                })}
                                <div class="conv-actions">
                                    <div class="conv-actions-left">
                                        <button type="button" class="subtle-delete-btn" data-del-cand="${escapeHtml(conv.id)}|${escapeHtml(cand.id)}" title="移除这张候选卡" aria-label="移除这张候选卡">
                                            <svg><use href="#i-trash"/></svg>
                                        </button>
                                    </div>
                                    <div class="conv-actions-right">
                                        ${renderAddCardActionHtml(cand.savedCardID, {
                                            addAttrs: `data-add-cand="${escapeHtml(conv.id)}|${escapeHtml(cand.id)}"`,
                                        })}
                                    </div>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            ` : '';

            return `
                <div class="conv-group">
                    <article class="conv-card" data-conv-id="${escapeHtml(conv.id)}">
                        ${msgsHtml}
                        ${loadingHtml}
                        <div class="conv-actions">
                            <div class="conv-actions-left">
                                <button type="button" class="pill-btn ghost sm" data-split-conv="${escapeHtml(conv.id)}" ${canSplit ? '' : 'disabled'}>
                                    ${isSplitting ? '拆分中...' : '拆分'}
                                </button>
                                <button type="button" class="subtle-delete-btn" data-del-conv="${escapeHtml(conv.id)}" title="移除本轮问答" aria-label="移除本轮问答">
                                    <svg><use href="#i-trash"/></svg>
                                </button>
                            </div>
                            <div class="conv-actions-right">
                                ${renderAddCardActionHtml(conv.mainSavedCardID, {
                                    addAttrs: `data-add-main="${escapeHtml(conv.id)}"`,
                                    canAdd,
                                })}
                            </div>
                        </div>
                    </article>
                    ${candGroupHtml}
                </div>
            `;
        }).join('');

        mainViewEl.innerHTML = `
            <div class="main-inner">
                <div class="ask-thread">${threadHtml}</div>
            </div>
        `;
    }

    // Bottom Dock: Token notice / error + Composer
    const provider = getProvider(store.settings.provider);
    const hasToken = Boolean(getApiToken(provider.id));
    const actions = store.getSortedQuickActions();

    const noticeHtml = !hasToken ? `
        <div class="notice-bar">
            <div class="notice-text">
                <div class="notice-title">还没填 ${escapeHtml(provider.displayName)} 的 API Token</div>
                ${!hasConvs ? '<div class="notice-detail">用你自己的 Token 直连 AI，填一次就好。</div>' : ''}
            </div>
            <button type="button" class="notice-btn" id="btn-go-token-settings">去设置</button>
        </div>
    ` : (askError ? `<div class="error-banner">${escapeHtml(askError)}</div>` : '');

    bottomDockEl.hidden = false;
    bottomDockEl.innerHTML = `
        ${noticeHtml}
        <div class="composer-box">
            <textarea class="composer-textarea" id="ask-input" rows="1" placeholder="问点什么...">${escapeHtml(askDraft.input)}</textarea>
            <div class="composer-bottom">
                <div class="chips-scroll">
                    ${actions.map((a, idx) => `
                        <button type="button" class="chip-btn" data-quick-action="${idx}" ${sendingConversationID ? 'disabled' : ''}>${escapeHtml(a.title)}</button>
                    `).join('')}
                </div>
                <button type="button" class="pill-btn primary sm" id="btn-ask-ai" ${sendingConversationID ? 'disabled' : ''}>问 AI</button>
            </div>
        </div>
    `;

    // Bind Ask events
    const goSettings = $('#btn-go-token-settings');
    if (goSettings) goSettings.addEventListener('click', jumpToProviderSettings);

    const askInput = $('#ask-input');
    autoResizeTextarea(askInput, 132);
    askInput.addEventListener('input', () => {
        askDraft.input = askInput.value;
        persistDraft();
        autoResizeTextarea(askInput, 132);
    });
    askInput.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            handleAskSubmit();
        }
    });

    $('#btn-ask-ai').addEventListener('click', () => handleAskSubmit());
    bottomDockEl.querySelectorAll('[data-quick-action]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const action = actions[Number(btn.dataset.quickAction)];
            if (action) handleAskSubmit({ instruction: action.prompt, frontSuffix: action.frontSuffix });
        });
    });

    // Thread events
    mainViewEl.querySelectorAll('[data-split-conv]').forEach(btn => {
        btn.addEventListener('click', () => handleSplitConversation(btn.dataset.splitConv));
    });
    mainViewEl.querySelectorAll('[data-add-main]').forEach(btn => {
        btn.addEventListener('click', () => handleAddMainCard(btn.dataset.addMain));
    });
    mainViewEl.querySelectorAll('[data-del-conv]').forEach(btn => {
        btn.addEventListener('click', () => handleDeleteConversation(btn.dataset.delConv));
    });
    mainViewEl.querySelectorAll('[data-add-cand]').forEach(btn => {
        const [convId, candId] = btn.dataset.addCand.split('|');
        btn.addEventListener('click', () => handleAddCandidateCard(convId, candId));
    });
    mainViewEl.querySelectorAll('[data-del-cand]').forEach(btn => {
        const [convId, candId] = btn.dataset.delCand.split('|');
        btn.addEventListener('click', () => handleDeleteCandidate(convId, candId));
    });
    mainViewEl.querySelectorAll('[data-edit-saved-card]').forEach(btn => {
        btn.addEventListener('click', () => openCardEditor(btn.dataset.editSavedCard, null));
    });
    mainViewEl.querySelectorAll('[data-copy-msg]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const [convId, msgId] = btn.dataset.copyMsg.split('|');
            const msg = askDraft.conversations.find(c => c.id === convId)?.messages.find(m => m.id === msgId);
            if (msg) { await copyText(msg.content); showToast('已复制'); }
        });
    });
    mainViewEl.querySelectorAll('[data-edit-msg]').forEach(btn => {
        btn.addEventListener('click', () => {
            const [convId, msgId] = btn.dataset.editMsg.split('|');
            const msg = askDraft.conversations.find(c => c.id === convId)?.messages.find(m => m.id === msgId);
            if (msg) {
                inlineEditTarget = { kind: 'message', convId, msgId, text: msg.content };
                render();
            }
        });
    });
    mainViewEl.querySelectorAll('[data-copy-cand]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const [convId, candId, side] = btn.dataset.copyCand.split('|');
            const cand = askDraft.conversations.find(c => c.id === convId)?.candidateCards?.find(c => c.id === candId);
            if (cand) { await copyText(side === 'front' ? cand.front : cand.back); showToast('已复制'); }
        });
    });
    mainViewEl.querySelectorAll('[data-edit-cand]').forEach(btn => {
        btn.addEventListener('click', () => {
            const [convId, candId, side] = btn.dataset.editCand.split('|');
            const cand = askDraft.conversations.find(c => c.id === convId)?.candidateCards?.find(c => c.id === candId);
            if (cand) {
                inlineEditTarget = { kind: 'candidate', convId, candId, side, text: side === 'front' ? cand.front : cand.back };
                render();
            }
        });
    });

    const inlineTa = $('#inline-edit-textarea');
    if (inlineTa) {
        inlineTa.focus();
        inlineTa.selectionStart = inlineTa.value.length;
        $('#btn-inline-cancel').addEventListener('click', () => {
            inlineEditTarget = null;
            render();
        });
        $('#btn-inline-save').addEventListener('click', () => commitInlineEdit(inlineTa.value));
    }
}

/* ---------- Rendering: Review Overview, Card List, Study, Card Editor ---------- */

function renderReviewOverview() {
    renderRootTopbar();
    bottomDockEl.hidden = true;
    const stats = ReviewQueue.stats(store.cards);
    const tiles = [
        { id: 'dueToday', val: stats.dueToday },
        { id: 'newToday', val: stats.newToday },
        { id: 'remembered', val: stats.remembered },
        { id: 'all', val: stats.total },
    ];

    mainViewEl.innerHTML = `
        <div class="main-inner full-height">
            <h1 class="page-title">今天的复习</h1>
            <div class="stats-card">
                <div class="stats-grid">
                    ${tiles.map(({ id, val }) => {
                        const cat = REVIEW_CATEGORIES[id];
                        return `
                            <button type="button" class="stat-tile" data-open-cat="${id}">
                                <div class="stat-tile-top">
                                    <span class="stat-value ${cat.color}">${val}</span>
                                    <svg class="stat-chevron"><use href="#i-chevron-right"/></svg>
                                </div>
                                <span class="stat-label">${escapeHtml(cat.title)}</span>
                            </button>
                        `;
                    }).join('')}
                </div>
            </div>

            <div class="review-extra-actions">
                <button type="button" class="text-action-btn" id="btn-manual-card">
                    <svg><use href="#i-plus"/></svg>手动新建卡片
                </button>
                ${stats.total === 0 ? `
                    <button type="button" class="text-action-btn" id="btn-review-samples">
                        <svg><use href="#i-spark"/></svg>载入示例卡片体验
                    </button>
                ` : ''}
            </div>

            <div class="review-footer-cta">
                <button type="button" class="pill-btn primary lg" id="btn-start-review" ${stats.hasWork ? '' : 'disabled'}>
                    ${stats.hasWork ? '开始复习' : '今天没有要复习的'}
                </button>
            </div>
        </div>
    `;

    mainViewEl.querySelectorAll('[data-open-cat]').forEach((btn) => {
        btn.addEventListener('click', () => {
            subview = { type: 'cardList', category: btn.dataset.openCat };
            render();
            mainViewEl.scrollTop = 0;
        });
    });

    $('#btn-start-review').addEventListener('click', startStudySession);

    $('#btn-manual-card').addEventListener('click', () => {
        subview = { type: 'cardEditor', cardId: null, returnTo: null };
        quickAskState = { input: '', exchanges: [], sendingId: null, error: '', inlineEdit: null };
        render();
    });

    const sampleBtn = $('#btn-review-samples');
    if (sampleBtn) {
        sampleBtn.addEventListener('click', () => {
            const count = store.loadSamples();
            showToast(`已载入 ${count} 张示例卡片`);
        });
    }
}

function renderCardPreviewList(categoryId) {
    const cat = REVIEW_CATEGORIES[categoryId] || REVIEW_CATEGORIES.all;
    const cards = ReviewQueue.cardsForCategory(cat.id, store.cards);
    const now = new Date();

    renderFlowTopbar({
        title: cat.title,
        onBack: () => { subview = null; render(); },
        rightHtml: `<span class="count-badge">${cards.length} 张</span>`,
    });
    bottomDockEl.hidden = true;

    if (!cards.length) {
        mainViewEl.innerHTML = `
            <div class="main-inner full-height">
                <div class="empty-state-center">
                    <h2>这里还没有卡片</h2>
                    <p>${escapeHtml(cat.summary)}</p>
                </div>
            </div>
        `;
        return;
    }

    mainViewEl.innerHTML = `
        <div class="main-inner">
            <p class="list-summary">${escapeHtml(cat.summary)}</p>
            <div class="preview-list">
                ${cards.map((card) => {
                    const plain = markdownPlainText(card.front) || card.front;
                    const status = ReviewQueue.cardStatusLabel(card, now);
                    return `
                        <div class="preview-row" data-open-card="${escapeHtml(card.id)}" role="button" tabindex="0">
                            <div class="preview-row-main">
                                <div class="preview-front">${escapeHtml(plain)}</div>
                                <div class="preview-status">${escapeHtml(status)}</div>
                            </div>
                            <button type="button" class="subtle-delete-btn" data-del-list-card="${escapeHtml(card.id)}" title="删除卡片" aria-label="删除卡片">
                                <svg><use href="#i-trash"/></svg>
                            </button>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;

    mainViewEl.querySelectorAll('[data-open-card]').forEach((row) => {
        row.addEventListener('click', (e) => {
            if (e.target.closest('[data-del-list-card]')) return;
            openCardEditor(row.dataset.openCard, { type: 'cardList', category: cat.id });
        });
        row.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openCardEditor(row.dataset.openCard, { type: 'cardList', category: cat.id });
            }
        });
    });

    mainViewEl.querySelectorAll('[data-del-list-card]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const cardId = btn.dataset.delListCard;
            showConfirm({
                title: '删除这张卡片？',
                desc: '删除后无法恢复。',
                okLabel: '删除',
                onConfirm: () => {
                    store.deleteCard(cardId);
                    unlinkSavedCardInDraft(cardId);
                    showToast('已删除卡片');
                },
            });
        });
    });
}

function renderStudyView() {
    if (!studySession) {
        startStudySession();
        return;
    }

    const current = studySession.queue[0] || null;
    const remaining = studySession.queue.length;
    const newCount = studySession.queue.filter(isCardNew).length;
    const reviewCount = remaining - newCount;

    topbarEl.innerHTML = `
        <div class="study-topbar">
            <button type="button" class="pill-btn ghost sm" id="btn-study-exit">
                ‹ 返回 <span class="kbd-hint">(Esc)</span>
            </button>
            <div class="study-chips">
                <span class="study-stat-chip"><i class="dot red"></i><span>${remaining}</span><span class="lbl">剩余</span></span>
                <span class="study-stat-chip"><i class="dot blue"></i><span>${newCount}</span><span class="lbl">新学</span></span>
                <span class="study-stat-chip"><i class="dot green"></i><span>${reviewCount}</span><span class="lbl">复习</span></span>
            </div>
            <button type="button" class="pill-btn ghost sm" id="btn-study-edit" ${current ? '' : 'disabled'}>编辑</button>
        </div>
    `;
    bottomDockEl.hidden = true;

    $('#btn-study-exit').addEventListener('click', () => {
        studySession = null;
        subview = null;
        render();
    });
    $('#btn-study-edit').addEventListener('click', () => {
        if (current) openCardEditor(current.id, { type: 'study' });
    });

    if (!current) {
        mainViewEl.innerHTML = `
            <div class="main-inner full-height">
                <div class="empty-state-center">
                    <h2>今天的任务完成了</h2>
                    <p>${studySession.completedCount > 0 ? `这一轮记了 ${studySession.completedCount} 张。` : '现在没有需要复习的卡片。'}</p>
                    <button type="button" class="pill-btn primary md" id="btn-study-done-back" style="margin-top: 14px;">返回</button>
                </div>
            </div>
        `;
        $('#btn-study-done-back').addEventListener('click', () => {
            studySession = null;
            subview = null;
            render();
        });
        return;
    }

    const cardHtml = studySession.isAnswerRevealed ? `
        <div class="md-content">${renderMarkdown(current.front)}</div>
        <div class="study-divider"></div>
        ${current.back
            ? `<div class="md-content">${renderMarkdown(current.back)}</div>`
            : '<p style="color:var(--muted);margin:0;">这张卡还没有背面内容。</p>'}
    ` : `
        <div class="md-content">${renderMarkdown(current.front)}</div>
        <div class="study-front-center">
            <div class="study-qmark">?</div>
            <div class="study-hint">想好后查看答案</div>
        </div>
    `;

    const now = new Date();
    const controlsHtml = studySession.isAnswerRevealed ? `
        <div class="rating-grid">
            ${RATINGS.map(r => `
                <button type="button" class="rating-btn ${r.color}" data-rate="${r.id}">
                    <span class="rating-btn-title">${r.title}<span class="kbd-hint">(${r.key})</span></span>
                    <span class="rating-btn-interval">${escapeHtml(SM2OSRScheduler.intervalPreview(r.id, current.review, now))}</span>
                </button>
            `).join('')}
        </div>
    ` : `
        <button type="button" class="pill-btn primary lg" id="btn-reveal-answer">
            显示答案 <span class="kbd-hint">(Space)</span>
        </button>
    `;

    mainViewEl.innerHTML = `
        <div class="main-inner full-height">
            <div class="study-shell">
                <div class="study-card">${cardHtml}</div>
                <div class="study-controls">${controlsHtml}</div>
                <div class="study-remaining">还剩 ${remaining} 张</div>
            </div>
        </div>
    `;

    const revealBtn = $('#btn-reveal-answer');
    if (revealBtn) revealBtn.addEventListener('click', revealStudyAnswer);

    mainViewEl.querySelectorAll('[data-rate]').forEach((btn) => {
        btn.addEventListener('click', () => rateCurrentStudyCard(btn.dataset.rate));
    });
}

function renderCardEditor(cardId) {
    const isNew = !cardId;
    const card = isNew ? { front: '', back: '' } : store.getCard(cardId);
    if (!card) {
        exitCardEditor();
        return;
    }

    renderFlowTopbar({
        title: isNew ? '新建卡片' : '编辑卡片',
        onBack: exitCardEditor,
    });
    bottomDockEl.hidden = true;

    mainViewEl.innerHTML = `
        <div class="main-inner">
            <div class="form-stack">
                <label class="field-label" for="editor-front">卡片正面</label>
                <textarea class="field-textarea" id="editor-front" rows="4" placeholder="正面内容">${escapeHtml(card.front)}</textarea>

                <label class="field-label" for="editor-back">卡片背面</label>
                <textarea class="field-textarea" id="editor-back" rows="8" placeholder="背面内容（支持 Markdown）">${escapeHtml(card.back)}</textarea>
            </div>

            <div class="editor-action-bar">
                ${!isNew ? '<button type="button" class="pill-btn danger-ghost md" id="btn-card-delete">删除</button>' : ''}
                <div class="editor-action-right">
                    <button type="button" class="pill-btn ghost md" id="btn-card-cancel">取消</button>
                    <button type="button" class="pill-btn primary md" id="btn-card-save">确认</button>
                </div>
            </div>
            <div style="height: 60px;"></div>
        </div>
        <button type="button" class="quick-ask-fab" id="btn-open-quick-ask">
            <svg><use href="#i-spark"/></svg>问 AI
        </button>
    `;

    const frontEl = $('#editor-front');
    const backEl = $('#editor-back');
    const saveBtn = $('#btn-card-save');

    const syncSaveBtn = () => {
        saveBtn.disabled = !frontEl.value.trim();
    };
    syncSaveBtn();
    frontEl.addEventListener('input', syncSaveBtn);

    $('#btn-card-cancel').addEventListener('click', exitCardEditor);
    $('#btn-open-quick-ask').addEventListener('click', openQuickAskModal);

    saveBtn.addEventListener('click', () => {
        const front = frontEl.value.trim();
        const back = backEl.value.trim();
        if (!front) return;
        if (isNew) {
            store.createCard({ front, back, sourceType: 'manual' });
            showToast('已创建卡片');
        } else {
            const updated = store.updateCard(cardId, { front, back });
            if (updated) {
                syncSavedCardToDraft(cardId, updated.front, updated.back);
                if (studySession) {
                    const idx = studySession.queue.findIndex(c => c.id === cardId);
                    if (idx >= 0) studySession.queue[idx] = updated;
                }
                showToast('已保存卡片');
            }
        }
        exitCardEditor();
    });

    const delBtn = $('#btn-card-delete');
    if (delBtn) {
        delBtn.addEventListener('click', () => {
            showConfirm({
                title: '删除这张卡片？',
                desc: '删除后无法恢复。',
                okLabel: '删除',
                onConfirm: () => {
                    store.deleteCard(cardId);
                    unlinkSavedCardInDraft(cardId);
                    if (studySession) {
                        studySession.queue = studySession.queue.filter(c => c.id !== cardId);
                        studySession.isAnswerRevealed = false;
                    }
                    showToast('已删除卡片');
                    exitCardEditor();
                },
            });
        });
    }
}

/* ---------- Rendering: Settings & Sub-Editors ---------- */

function renderSettingsView() {
    renderRootTopbar();
    bottomDockEl.hidden = true;

    const actions = store.getSortedQuickActions();
    const selectedProviderId = store.settings.provider;

    mainViewEl.innerHTML = `
        <div class="main-inner">
            <h2 class="section-heading">快捷操作</h2>
            <div class="settings-card">
                ${actions.map((action, idx) => `
                    <div class="action-list-row">
                        <span class="action-order-num">${idx + 1}</span>
                        <div class="action-reorder-btns">
                            <button type="button" class="reorder-btn" data-move-up="${idx}" ${idx === 0 ? 'disabled' : ''} aria-label="上移">
                                <svg><use href="#i-chevron-up"/></svg>
                            </button>
                            <button type="button" class="reorder-btn" data-move-down="${idx}" ${idx === actions.length - 1 ? 'disabled' : ''} aria-label="下移">
                                <svg><use href="#i-chevron-down"/></svg>
                            </button>
                        </div>
                        <button type="button" class="action-row-btn" data-edit-action="${escapeHtml(action.id)}">
                            <div>
                                <div class="action-row-title">${escapeHtml(action.title)}</div>
                            </div>
                            <svg class="row-chevron"><use href="#i-chevron-right"/></svg>
                        </button>
                    </div>
                `).join('')}

                ${actions.length < MAX_QUICK_ACTIONS ? `
                    <div class="action-list-row">
                        <button type="button" class="action-row-btn" id="btn-add-action" style="color:var(--muted);">
                            <span style="display:inline-flex;align-items:center;gap:6px;font-weight:600;">
                                <svg style="width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2;"><use href="#i-plus"/></svg>
                                新增快捷操作
                            </span>
                            <svg class="row-chevron"><use href="#i-chevron-right"/></svg>
                        </button>
                    </div>
                ` : ''}

                <div class="settings-card-footer">
                    <div class="field-caption">调整顺序后，问页面底部按钮会按同样顺序出现（最多 ${MAX_QUICK_ACTIONS} 个）。</div>
                    <div>
                        <button type="button" class="text-action-btn" id="btn-restore-presets">
                            <svg><use href="#i-reset"/></svg>恢复系统预设
                        </button>
                    </div>
                </div>

                <div class="settings-divider"></div>

                <div class="action-list-row">
                    <button type="button" class="action-row-btn" id="btn-edit-split-prompt">
                        <div>
                            <div class="action-row-title">拆分 Prompt</div>
                            <div class="action-row-sub">决定一轮问答被拆成什么样的卡片。</div>
                        </div>
                        <svg class="row-chevron"><use href="#i-chevron-right"/></svg>
                    </button>
                </div>
            </div>

            <h2 class="section-heading" id="settings-provider-anchor">AI 提供商</h2>
            <div class="provider-stack">
                ${PROVIDER_ORDER.map((pid) => {
                    const p = AI_PROVIDERS[pid];
                    const isSelected = pid === selectedProviderId;
                    if (!isSelected) {
                        return `
                            <div class="provider-card">
                                <button type="button" class="provider-header" data-select-provider="${pid}">
                                    <span class="radio-ring"></span>
                                    <span class="provider-name">${escapeHtml(p.displayName)}</span>
                                </button>
                            </div>
                        `;
                    }
                    const currentModel = resolveModel(pid, store.settings.modelsByProvider);
                    const modelOptions = p.knownModels.includes(currentModel)
                        ? p.knownModels
                        : [...p.knownModels, currentModel];
                    const storedToken = getApiToken(pid);
                    return `
                        <div class="provider-card ${highlightProvider ? 'highlighted' : ''}">
                            <div class="provider-header">
                                <span class="radio-ring"><span class="radio-dot"></span></span>
                                <span class="provider-name">${escapeHtml(p.displayName)}</span>
                            </div>
                            <div class="provider-body">
                                <label class="field-label" for="provider-model-select">Model</label>
                                <select class="field-select" id="provider-model-select">
                                    ${modelOptions.map(m => `<option value="${escapeHtml(m)}" ${m === currentModel ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')}
                                </select>

                                <label class="field-label" for="provider-token-input">API Token</label>
                                <div class="token-row">
                                    <input
                                        class="field-input"
                                        id="provider-token-input"
                                        type="${tokenVisible ? 'text' : 'password'}"
                                        autocomplete="off"
                                        spellcheck="false"
                                        value="${escapeHtml(storedToken)}"
                                        placeholder="${storedToken ? '已保存，可直接修改' : '粘贴 API Token（仅存于本机浏览器）'}"
                                    >
                                    <button type="button" class="token-toggle" id="btn-toggle-token-vis">${tokenVisible ? '隐藏' : '显示'}</button>
                                </div>
                                <a class="console-link" href="${escapeHtml(p.tokenConsoleURL)}" target="_blank" rel="noopener noreferrer">
                                    <span>${escapeHtml(p.tokenConsoleTitle)}</span>
                                    <svg><use href="#i-external"/></svg>
                                </a>

                                <div class="test-row">
                                    <button type="button" class="pill-btn primary md" id="btn-test-conn" ${testState.status === 'testing' ? 'disabled' : ''}>
                                        ${testState.status === 'testing' ? '测试中...' : '测试连接'}
                                    </button>
                                    <span class="test-status ${testState.status === 'ok' ? 'ok' : (testState.status === 'err' ? 'err' : '')}" id="test-conn-status">${escapeHtml(testState.label)}</span>
                                </div>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>

            <h2 class="section-heading">云同步与数据</h2>
            <div class="settings-card">
                <div class="sync-summary-line">
                    <span>Cloudflare 云同步</span>
                    <span class="about-muted" id="settings-sync-status">${escapeHtml(formatSettingsSyncSummary(lastSyncInfo))}</span>
                </div>
                <div class="data-actions-grid">
                    <button type="button" class="pill-btn primary sm" id="btn-open-sync-settings">云同步设置</button>
                    ${lastSyncInfo.configured ? '<button type="button" class="pill-btn ghost sm" id="btn-settings-sync-now">立即同步</button>' : ''}
                    <button type="button" class="pill-btn ghost sm" id="btn-export-json">导出 JSON 备份</button>
                    <button type="button" class="pill-btn ghost sm" id="btn-import-json">导入 JSON 备份</button>
                    <button type="button" class="pill-btn ghost sm" id="btn-export-md">导出 Markdown</button>
                    <button type="button" class="pill-btn ghost sm" id="btn-load-samples">载入示例卡片</button>
                </div>
                <div class="field-caption" style="padding-bottom: 10px;">
                    卡片与设置使用 Cloudflare Worker + D1 同步（与同域名下的 MyMind / MyList 共用配置）。API Token 仅保存在本机浏览器，随 JSON 备份及配对码一起导入导出，不上传到云端文档。
                </div>
            </div>

            <h2 class="section-heading">关于</h2>
            <div class="settings-card">
                <div class="about-row">
                    <span>ai问记 Web</span>
                    <span class="about-muted">v${APP_VERSION}</span>
                </div>
                <div class="about-row">
                    <span>复习算法</span>
                    <span class="about-muted">SM-2-OSR</span>
                </div>
                <div class="about-row">
                    <span>快捷键（桌面端）</span>
                    <span class="about-muted">${isMac ? '⌘' : 'Ctrl+'}↩ 问 AI · ${isMac ? '⌘' : 'Ctrl+'}1-9 快捷操作 · Space 翻面 · 0-3 评分 · ${isMac ? '⌘' : 'Ctrl+'}S 同步</span>
                </div>
            </div>
        </div>
    `;

    // Quick Action events
    mainViewEl.querySelectorAll('[data-move-up]').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = Number(btn.dataset.moveUp);
            store.moveQuickAction(idx, idx - 1);
        });
    });
    mainViewEl.querySelectorAll('[data-move-down]').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = Number(btn.dataset.moveDown);
            store.moveQuickAction(idx, idx + 1);
        });
    });
    mainViewEl.querySelectorAll('[data-edit-action]').forEach(btn => {
        btn.addEventListener('click', () => {
            subview = { type: 'quickActionEditor', actionId: btn.dataset.editAction };
            render();
            mainViewEl.scrollTop = 0;
        });
    });
    const addActionBtn = $('#btn-add-action');
    if (addActionBtn) {
        addActionBtn.addEventListener('click', () => {
            subview = { type: 'quickActionEditor', actionId: null };
            render();
            mainViewEl.scrollTop = 0;
        });
    }
    $('#btn-restore-presets').addEventListener('click', () => {
        showConfirm({
            title: '恢复系统预设？',
            desc: '将恢复「翻译」「教我读」「教我记」的名称、Prompt、正面后缀与顺序；你新增的快捷操作会保留在后面。',
            okLabel: '恢复预设',
            danger: false,
            onConfirm: () => {
                store.restoreSystemQuickActions();
                showToast('已恢复系统预设');
            },
        });
    });
    $('#btn-edit-split-prompt').addEventListener('click', () => {
        subview = { type: 'splitPromptEditor' };
        render();
        mainViewEl.scrollTop = 0;
    });

    // Provider events
    mainViewEl.querySelectorAll('[data-select-provider]').forEach(btn => {
        btn.addEventListener('click', () => {
            testState = { status: 'untested', label: '未测试' };
            tokenVisible = false;
            store.selectProvider(btn.dataset.selectProvider);
        });
    });
    const modelSel = $('#provider-model-select');
    if (modelSel) {
        modelSel.addEventListener('change', () => {
            testState = { status: 'untested', label: '未测试' };
            store.selectModel(modelSel.value, selectedProviderId);
        });
    }
    const tokenInput = $('#provider-token-input');
    if (tokenInput) {
        const persistToken = () => {
            setApiToken(selectedProviderId, tokenInput.value);
        };
        tokenInput.addEventListener('change', persistToken);
        tokenInput.addEventListener('blur', persistToken);
        tokenInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                persistToken();
                tokenInput.blur();
                showToast('API Token 已保存');
            }
        });
    }
    const toggleVis = $('#btn-toggle-token-vis');
    if (toggleVis && tokenInput) {
        toggleVis.addEventListener('click', () => {
            tokenVisible = !tokenVisible;
            tokenInput.type = tokenVisible ? 'text' : 'password';
            toggleVis.textContent = tokenVisible ? '隐藏' : '显示';
        });
    }
    const testBtn = $('#btn-test-conn');
    if (testBtn && tokenInput) {
        testBtn.addEventListener('click', async () => {
            const token = setApiToken(selectedProviderId, tokenInput.value);
            testState = { status: 'testing', label: '测试中...' };
            render();
            try {
                const msg = await testAIConnection({ settings: store.settings, token });
                testState = { status: 'ok', label: msg };
            } catch (err) {
                testState = { status: 'err', label: err?.message || '连接失败' };
            }
            render();
        });
    }

    // Sync & Backup events
    $('#btn-open-sync-settings').addEventListener('click', () => sync.openSettings());
    const syncNowBtn = $('#btn-settings-sync-now');
    if (syncNowBtn) syncNowBtn.addEventListener('click', () => sync.syncNow({ manual: true }));
    $('#btn-export-json').addEventListener('click', () => {
        downloadFile(store.exportJSON(exportApiTokens()), `aiwenji-${toDateStr()}.json`, 'application/json;charset=utf-8');
        showToast('已导出 JSON 备份');
    });
    $('#btn-import-json').addEventListener('click', () => {
        fileInput.value = '';
        fileInput.click();
    });
    $('#btn-export-md').addEventListener('click', () => {
        downloadFile(store.exportMarkdown(), `aiwenji-cards-${toDateStr()}.md`, 'text/markdown;charset=utf-8');
        showToast('已导出 Markdown');
    });
    $('#btn-load-samples').addEventListener('click', () => {
        const count = store.loadSamples();
        showToast(`已载入 ${count} 张示例卡片`);
    });
}

function renderQuickActionEditor(actionId) {
    const existing = actionId ? store.settings.quickActions.find(a => a.id === actionId) : null;
    const isEditing = Boolean(existing);

    renderFlowTopbar({
        title: isEditing ? '编辑操作' : '新增操作',
        onBack: () => { subview = null; render(); },
    });
    bottomDockEl.hidden = true;

    const suffixText = existing?.frontSuffix?.text || '';
    const applySplit = Boolean(existing?.frontSuffix?.appliesToSplitCards);

    mainViewEl.innerHTML = `
        <div class="main-inner">
            <div class="form-stack">
                <label class="field-label" for="qa-title">名称</label>
                <input class="field-input" id="qa-title" type="text" maxlength="24" placeholder="翻译" value="${escapeHtml(existing?.title || '')}">

                <label class="field-label" for="qa-suffix">卡片正面后缀</label>
                <input class="field-input" id="qa-suffix" type="text" maxlength="32" placeholder="（翻译）" value="${escapeHtml(suffixText)}">
                <p class="field-caption">用这个操作提问时加在问题末尾，加入卡片后就是正面的一部分；留空则不加。</p>

                <div class="toggle-row ${suffixText ? '' : 'disabled'}" id="qa-split-toggle-row" style="margin-top:6px;">
                    <span>也用在拆分卡片上</span>
                    <label class="toggle-switch">
                        <input type="checkbox" id="qa-apply-split" ${applySplit ? 'checked' : ''} ${suffixText ? '' : 'disabled'}>
                        <span class="toggle-slider"></span>
                    </label>
                </div>
                <p class="field-caption">拆出来的卡片正面同样隐含这个意图时才打开，例如翻译。</p>

                <label class="field-label" for="qa-prompt">Prompt</label>
                <textarea class="field-textarea" id="qa-prompt" rows="8" placeholder="点击这个操作时附加给 AI 的提示词">${escapeHtml(existing?.prompt || '')}</textarea>
            </div>

            <div class="editor-action-bar">
                ${isEditing ? '<button type="button" class="pill-btn danger-ghost md" id="btn-qa-delete">删除</button>' : ''}
                <div class="editor-action-right">
                    <button type="button" class="pill-btn ghost md" id="btn-qa-cancel">取消</button>
                    <button type="button" class="pill-btn primary md" id="btn-qa-save">确认</button>
                </div>
            </div>
        </div>
    `;

    const titleEl = $('#qa-title');
    const suffixEl = $('#qa-suffix');
    const splitToggleRow = $('#qa-split-toggle-row');
    const splitCheck = $('#qa-apply-split');
    const promptEl = $('#qa-prompt');
    const saveBtn = $('#btn-qa-save');

    const syncForm = () => {
        const hasSuffix = Boolean(suffixEl.value.trim());
        splitCheck.disabled = !hasSuffix;
        splitToggleRow.classList.toggle('disabled', !hasSuffix);
        saveBtn.disabled = !titleEl.value.trim() || !promptEl.value.trim();
    };
    syncForm();
    titleEl.addEventListener('input', syncForm);
    suffixEl.addEventListener('input', syncForm);
    promptEl.addEventListener('input', syncForm);

    $('#btn-qa-cancel').addEventListener('click', () => { subview = null; render(); });
    saveBtn.addEventListener('click', () => {
        const suffixClean = suffixEl.value.trim();
        const payload = {
            title: titleEl.value.trim(),
            prompt: promptEl.value.trim(),
            frontSuffix: {
                text: suffixClean,
                appliesToSplitCards: Boolean(suffixClean && splitCheck.checked),
            },
        };
        if (isEditing) store.updateQuickAction(existing.id, payload);
        else store.addQuickAction(payload);
        subview = null;
        render();
        showToast(isEditing ? '已更新快捷操作' : '已新增快捷操作');
    });

    const delBtn = $('#btn-qa-delete');
    if (delBtn) {
        delBtn.addEventListener('click', () => {
            showConfirm({
                title: '删除这个快捷操作？',
                desc: '问页面底部会不再显示这个按钮。',
                okLabel: '删除',
                onConfirm: () => {
                    store.deleteQuickAction(existing.id);
                    subview = null;
                    render();
                    showToast('已删除快捷操作');
                },
            });
        });
    }
}

function renderSplitPromptEditor() {
    renderFlowTopbar({
        title: '拆分 Prompt',
        onBack: () => { subview = null; render(); },
    });
    bottomDockEl.hidden = true;

    mainViewEl.innerHTML = `
        <div class="main-inner">
            <div class="form-stack">
                <label class="field-label" for="split-prompt-ta">Prompt</label>
                <textarea class="field-textarea" id="split-prompt-ta" rows="12" placeholder="描述希望如何拆分问答">${escapeHtml(store.settings.splitPrompt)}</textarea>
                <p class="field-caption">只写拆分逻辑。输出格式由系统提示词固定，保证结果能被解析成一张张卡片。</p>
            </div>

            <div class="editor-action-bar">
                <button type="button" class="pill-btn ghost md" id="btn-split-restore">恢复默认</button>
                <div class="editor-action-right">
                    <button type="button" class="pill-btn ghost md" id="btn-split-cancel">取消</button>
                    <button type="button" class="pill-btn primary md" id="btn-split-save">确认</button>
                </div>
            </div>
        </div>
    `;

    const ta = $('#split-prompt-ta');
    const saveBtn = $('#btn-split-save');
    const syncBtn = () => { saveBtn.disabled = !ta.value.trim(); };
    syncBtn();
    ta.addEventListener('input', syncBtn);

    $('#btn-split-restore').addEventListener('click', () => {
        store.restoreDefaultSplitPrompt();
        ta.value = DEFAULT_SPLIT_PROMPT;
        syncBtn();
        showToast('已恢复默认拆分 Prompt');
    });
    $('#btn-split-cancel').addEventListener('click', () => { subview = null; render(); });
    saveBtn.addEventListener('click', () => {
        if (!ta.value.trim()) return;
        store.updateSplitPrompt(ta.value);
        subview = null;
        render();
        showToast('已保存拆分 Prompt');
    });
}

/* ---------- Master Render ---------- */

function render() {
    if (subview) {
        switch (subview.type) {
            case 'cardList':
                renderCardPreviewList(subview.category);
                return;
            case 'study':
                renderStudyView();
                return;
            case 'cardEditor':
                renderCardEditor(subview.cardId);
                return;
            case 'quickActionEditor':
                renderQuickActionEditor(subview.actionId);
                return;
            case 'splitPromptEditor':
                renderSplitPromptEditor();
                return;
        }
    }

    switch (currentTab) {
        case 'review':
            renderReviewOverview();
            break;
        case 'settings':
            renderSettingsView();
            break;
        case 'ask':
        default:
            renderAskView();
            break;
    }
}

/* ---------- JSON Import Handler ---------- */

fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const res = store.importJSON(text);
        const importedTokens = importApiTokens(parsed?.secrets);
        const tokenMsg = importedTokens ? '及 API Token' : '';
        showToast(`已导入 ${res.total} 张卡片（新增 ${res.added} / 更新 ${res.updated}）${tokenMsg}`);
    } catch (err) {
        showToast(`导入失败：${err?.message || '格式不正确'}`);
    }
});

/* ---------- Hardware Keyboard Shortcuts (Matches iOS aiwenji + MyMind/MyList) ---------- */

window.addEventListener('keydown', (e) => {
    if (sync.isModalOpen()) return;
    if (!confirmModal.hidden) {
        if (e.key === 'Escape') { e.preventDefault(); closeConfirm(); }
        return;
    }

    // ⌘S / Ctrl+S: Force cloud sync
    if ((isMac ? e.metaKey : e.ctrlKey) && !e.altKey && e.code === 'KeyS') {
        e.preventDefault();
        if (sync.isConfigured()) sync.syncNow({ manual: true });
        else showToast('已保存到本地');
        return;
    }

    // Quick Ask modal shortcuts (⌘1..9, ⌘0)
    if (!quickAskSheet.hidden) {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeQuickAskModal();
            return;
        }
        if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && /^[0-9]$/.test(e.key)) {
            const idx = e.key === '0' ? 9 : Number(e.key) - 1;
            const action = store.getSortedQuickActions()[idx];
            if (action) {
                e.preventDefault();
                handleQuickAskSend({ instruction: action.prompt, frontSuffix: action.frontSuffix });
            }
        }
        return;
    }

    const inField = e.target.matches('input, textarea, select, [contenteditable="true"]');

    // Ask tab shortcuts: ⌘1..9, ⌘0 trigger quick actions 1..10
    if (currentTab === 'ask' && !subview && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && /^[0-9]$/.test(e.key)) {
        const idx = e.key === '0' ? 9 : Number(e.key) - 1;
        const action = store.getSortedQuickActions()[idx];
        if (action) {
            e.preventDefault();
            handleAskSubmit({ instruction: action.prompt, frontSuffix: action.frontSuffix });
            return;
        }
    }

    // Study view shortcuts: Esc, Space, 0/1/2/3
    if (subview?.type === 'study' && studySession && !inField) {
        if (e.key === 'Escape') {
            e.preventDefault();
            studySession = null;
            subview = null;
            render();
            return;
        }
        if (!studySession.queue.length) return;
        if (!studySession.isAnswerRevealed && e.code === 'Space') {
            e.preventDefault();
            revealStudyAnswer();
            return;
        }
        if (studySession.isAnswerRevealed && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const map = { '0': 'again', '1': 'hard', '2': 'good', '3': 'easy' };
            if (map[e.key]) {
                e.preventDefault();
                rateCurrentStudyCard(map[e.key]);
            }
        }
        return;
    }

    // Review overview: Space starts review when today has tasks
    if (currentTab === 'review' && !subview && !inField && e.code === 'Space' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (ReviewQueue.stats(store.cards).hasWork) {
            e.preventDefault();
            startStudySession();
        }
    }
}, true);

/* ---------- Cross-tab Storage Sync ---------- */

window.addEventListener('storage', (e) => {
    if (e.key === 'aiwenji:v1:state') {
        store.load();
        render();
    } else if (e.key === 'aiwenji:v1:secrets') {
        render();
    }
});

/* ---------- URL Query Deep Links (?tab=review, ?tab=ask&text=...&send=1&action=N) ---------- */

function handleQueryEntry() {
    const params = new URLSearchParams(location.search);
    const tabParam = (params.get('tab') || '').toLowerCase();
    if (!tabParam && !params.has('text')) return;

    // Clean query string so reload doesn't replay
    try {
        history.replaceState(null, '', location.pathname + location.hash);
    } catch { /* ignore */ }

    if (tabParam === 'review') {
        currentTab = 'review';
        subview = null;
        if (ReviewQueue.stats(store.cards).hasWork) {
            startStudySession();
        } else {
            render();
        }
        return;
    }

    if (tabParam === 'settings') {
        switchTab('settings');
        return;
    }

    if (tabParam === 'ask' || params.has('text')) {
        currentTab = 'ask';
        subview = null;
        const text = params.get('text');
        if (text != null) {
            askDraft.input = text;
            persistDraft();
        }
        render();

        const trimmed = (askDraft.input || '').trim();
        const actionRaw = params.get('action');
        const sendRaw = (params.get('send') || '').toLowerCase();
        if (trimmed && actionRaw !== null && /^\d+$/.test(actionRaw.trim())) {
            const num = Number(actionRaw.trim());
            if (num === 0) {
                handleAskSubmit();
            } else {
                const action = store.getSortedQuickActions()[num - 1];
                if (action) handleAskSubmit({ instruction: action.prompt, frontSuffix: action.frontSuffix });
                else handleAskSubmit();
            }
        } else if (trimmed && ['1', 'true', 'yes'].includes(sendRaw)) {
            handleAskSubmit();
        } else {
            requestAnimationFrame(() => $('#ask-input')?.focus());
        }
    }
}

/* ---------- Midnight Rollover Check ---------- */

let lastDay = toDateStr();
setInterval(() => {
    const today = toDateStr();
    if (today !== lastDay) {
        lastDay = today;
        if (currentTab === 'review') render();
    }
}, 60000);

/* ---------- Version Update Toast (Follows MyMind) ---------- */

function checkVersionUpdate(hadExistingData) {
    let seen = null;
    try { seen = localStorage.getItem(VERSION_KEY); } catch { return; }
    const upgraded = seen ? compareVersions(APP_VERSION, seen) > 0 : hadExistingData;
    if (!seen || upgraded) {
        try { localStorage.setItem(VERSION_KEY, APP_VERSION); } catch { /* not critical */ }
    }
    if (upgraded) {
        const note = RELEASES[0]?.note;
        showToast(note ? `已更新至 v${APP_VERSION}：${note}` : `已更新至 v${APP_VERSION}`, { duration: 4500 });
    }
}

/* ---------- Bootstrap & Service Worker Registration (Follows MyMind & MyList) ---------- */

let hadExistingData = false;
try { hadExistingData = localStorage.getItem(STORAGE_KEY) !== null; } catch { /* storage unavailable */ }
render();
handleQueryEntry();
sync.start();
checkVersionUpdate(hadExistingData);

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register(new URL('./sw.js', import.meta.url))
        .then(() => navigator.serviceWorker.ready)
        .then(() => {
            const key = 'aiwenji.offline.ready.v1';
            if (!localStorage.getItem(key)) {
                localStorage.setItem(key, '1');
                showToast('离线已就绪，断网也能打开');
            }
        })
        .catch((error) => {
            console.warn('ai问记 service worker registration failed', error);
        });
}
