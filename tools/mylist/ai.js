/**
 * MyList AI image recognition via OpenAI Chat Completions Vision API.
 * - Stores the user's ChatGPT (OpenAI) API key locally in localStorage.
 * - Resizes large mobile photos on-device before upload.
 * - Extracts concise tasks formatted for MyList's composer syntax.
 */

import { expandQuickDue } from './model.js?v=4';

export const AI_SETTINGS_KEY = 'mylist:v1:settings';
export const DEFAULT_VISION_MODEL = 'gpt-6.2-sol';
const FALLBACK_VISION_MODELS = ['gpt-6-luna', 'gpt-5.4-mini'];
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const MAX_IMAGE_DIM = 1600;
const JPEG_QUALITY = 0.86;
const MAX_TASK_LEN = 300;
const MAX_TASKS = 20;

const pad2 = n => String(n).padStart(2, '0');

/* ---------- Settings Persistence & Backup Helpers ---------- */

export function readAISettings() {
    try {
        const raw = localStorage.getItem(AI_SETTINGS_KEY);
        if (!raw) return { openaiApiKey: '' };
        const parsed = JSON.parse(raw);
        const openaiApiKey = typeof parsed?.openaiApiKey === 'string' ? parsed.openaiApiKey.trim() : '';
        return { openaiApiKey };
    } catch {
        return { openaiApiKey: '' };
    }
}

export function getOpenAIApiKey() {
    return readAISettings().openaiApiKey;
}

export function hasOpenAIApiKey() {
    return getOpenAIApiKey().length > 0;
}

export function setOpenAIApiKey(rawKey) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    try {
        if (!key) {
            localStorage.removeItem(AI_SETTINGS_KEY);
            return '';
        }
        localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify({ openaiApiKey: key }));
    } catch {
        // Ignore storage errors
    }
    return key;
}

/** Return settings object for JSON backup / pairing export, or null when empty. */
export function exportAISettings() {
    const openaiApiKey = getOpenAIApiKey();
    return openaiApiKey ? { openaiApiKey } : null;
}

/**
 * Restore settings from JSON backup or pairing payload.
 * Leaves the existing key untouched if the payload does not contain a non-empty key.
 * Returns true if an API key was applied.
 */
export function importAISettings(raw) {
    const candidate = typeof raw?.openaiApiKey === 'string' ? raw.openaiApiKey.trim() : '';
    if (!candidate) return false;
    setOpenAIApiKey(candidate);
    return true;
}

/* ---------- Client-Side Image Preparation ---------- */

function readBlobAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('无法读取图片文件'));
        reader.readAsDataURL(blob);
    });
}

function loadImageFromUrl(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('图片解码失败'));
        img.src = url;
    });
}

export async function fileToVisionDataUrl(file) {
    if (!file) throw new Error('未选择图片');
    const url = URL.createObjectURL(file);
    try {
        const img = await loadImageFromUrl(url);
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (!w || !h) throw new Error('图片尺寸无效');

        const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(w, h));
        const targetW = Math.max(1, Math.round(w * scale));
        const targetH = Math.max(1, Math.round(h * scale));

        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        if (!ctx) return await readBlobAsDataUrl(file);

        // White matte so transparent PNG screenshots remain crisp after JPEG encoding
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, targetW, targetH);
        ctx.drawImage(img, 0, 0, targetW, targetH);
        return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    } catch {
        // Fallback for formats canvas cannot decode directly
        const fallback = await readBlobAsDataUrl(file);
        if (!fallback.startsWith('data:image/')) {
            throw new Error('不支持的图片格式，请尝试 JPG / PNG / WebP 截图');
        }
        return fallback;
    } finally {
        URL.revokeObjectURL(url);
    }
}

/* ---------- Prompt Construction & Output Normalization ---------- */

function formatNowContext(now) {
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}（星期${weekdays[now.getDay()]}）`;
}

function buildSystemPrompt(now) {
    return [
        '你是 MyList 待办应用的高精度图片解析助手。用户会上传截图或照片（如聊天记录、日程邀请、票务订单、取件码、账单提醒、手写清单等），请识别其中的待办事项，并严格按照 MyList 输入框格式输出 JSON。',
        '',
        `当前本地时间：${formatNowContext(now)}`,
        '',
        '【MyList 输入框格式规范】',
        '1. 无日期即时待办（放入「现在」）：直接写简洁任务内容，不加日期后缀。例如：买牛奶',
        '2. 带日期/时间的待办：在任务内容末尾加一个空格和日期，格式必须为 `MM.DD` 或 `MM.DD HH:MM`（两位月.两位日，24小时制，不要写年份）。',
        '   - 必须根据当前本地时间，将图片中的相对日期（如“明天下午3点”、“本周五”、“下周一 9:30”、“今晚8点”）准确换算为具体的 `MM.DD` 或 `MM.DD HH:MM`。',
        '   - 例如：参加产品评审会 11.27 14:30、提交差旅报销单 11.25、取顺丰快递（取件码 8-2-3041） 11.24 20:00',
        '3. 循环任务：仅当图片明确表达定期重复时，在日期前加 `rd`（每天）、`rw`（每周）或 `rm`（每月）。',
        '   - 例如：团队周会 rw 11.30 10:00、交房租 rm 12.01',
        '4. 以后再做：仅当图片内容明显属于无时间要求的长期想法、心愿、书单影单或备忘时，在末尾紧贴加 `...`（且不带日期）。',
        '   - 例如：看《三体》原著...',
        '',
        '【提炼原则】',
        '- 简洁自然，与图片主要语言保持一致；保留关键识别信息（如时间、地点、取件码、航班/车次号、金额、联系人等），剔除客套话、界面按钮和无关装饰文字。',
        '- 每条任务单行、不含项目符号（如 - / 1. / •），不超过 120 字。',
        '- 如果整张图围绕同一件事（如一张车票/机票、一封会议通知、一条聊天提醒、一张缴费通知），合并提炼为 1 条任务，不要拆碎。',
        '- 仅当图片中明确包含多条相互独立的待办事项（如待办清单、手写多条事项、含多个独立行动项的纪要）时，才返回多条（最多 20 条）。',
        '- 如果图片中完全没有可提取的任务或提醒，返回空数组。',
        '',
        '【输出格式】',
        '仅输出严格合法的 JSON 对象，不要包含额外解释：',
        '{"tasks": ["任务1"]}',
    ].join('\n');
}

function cleanSingleTask(raw, now) {
    if (typeof raw !== 'string') return '';
    let s = raw
        .replace(/[\r\n]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    // Strip accidental list markers / checkboxes
    s = s.replace(/^(?:[-*•·]\s*|\d+[.)、]\s*|\[\s?[xX]?\s?\]\s*)+/, '').trim();
    if (!s) return '';

    const isSomeday = s.endsWith('...');
    if (isSomeday) {
        const core = s.slice(0, -3).trimEnd();
        if (!core) return '';
        s = `${core}...`;
    } else {
        s = expandQuickDue(s, now);
    }

    if (s.length > MAX_TASK_LEN) {
        s = s.slice(0, MAX_TASK_LEN).trimEnd();
    }
    return s;
}

function extractMessageText(data) {
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map(part => (typeof part === 'string' ? part : part?.text || ''))
            .join('\n');
    }
    return '';
}

export function parseRecognizedTasks(rawContent, now = new Date()) {
    const text = String(rawContent || '').trim();
    if (!text) return [];

    // Strip optional markdown code fences
    const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    let list = null;

    const tryParseJson = (str) => {
        try {
            return JSON.parse(str);
        } catch {
            return null;
        }
    };

    let parsed = tryParseJson(unfenced);
    if (!parsed) {
        const objMatch = unfenced.match(/\{[\s\S]*\}/);
        if (objMatch) parsed = tryParseJson(objMatch[0]);
    }

    if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.tasks)) list = parsed.tasks;
        else if (typeof parsed.task === 'string') list = [parsed.task];
        else if (Array.isArray(parsed)) list = parsed;
    }

    if (!list) {
        // Graceful fallback if the model returned plain lines instead of JSON
        list = unfenced.split(/\r?\n/).filter(Boolean);
    }

    const out = [];
    const seen = new Set();
    for (const item of list) {
        const cleaned = cleanSingleTask(typeof item === 'string' ? item : item?.text, now);
        if (!cleaned || seen.has(cleaned)) continue;
        seen.add(cleaned);
        out.push(cleaned);
        if (out.length >= MAX_TASKS) break;
    }
    return out;
}

/* ---------- OpenAI API Request with Graceful Model Fallback ---------- */

function shouldFallbackModel(status, errData) {
    if (status === 404) return true;
    const code = String(errData?.error?.code || '').toLowerCase();
    const msg = String(errData?.error?.message || '').toLowerCase();
    return (
        code === 'model_not_found' ||
        msg.includes('does not exist') ||
        msg.includes('model_not_found') ||
        msg.includes('not found') ||
        msg.includes('not have access to model')
    );
}

function formatApiError(status, errData) {
    const rawMsg = errData?.error?.message || '';
    if (status === 401) return 'API Key 无效或已过期，请在 AI 识别设置中检查';
    if (status === 403) return 'API Key 无权访问该模型或当前网络区域受限';
    if (status === 429) return '请求过于频繁或 OpenAI 额度不足，请稍后重试';
    if (status >= 500) return 'OpenAI 服务暂时异常，请稍后重试';
    return rawMsg ? `识别失败：${rawMsg}` : `识别失败 (HTTP ${status})`;
}

async function callVisionOnce({ apiKey, model, systemPrompt, imageDataUrl, signal, includeReasoningEffort = true }) {
    const body = {
        model,
        max_completion_tokens: 1024,
        response_format: { type: 'json_object' },
        messages: [
            { role: 'system', content: systemPrompt },
            {
                role: 'user',
                content: [
                    { type: 'text', text: '请识别这张图片中的待办任务，并按 MyList 输入框格式返回 JSON。' },
                    {
                        type: 'image_url',
                        image_url: {
                            url: imageDataUrl,
                            detail: 'auto',
                        },
                    },
                ],
            },
        ],
    };
    if (includeReasoningEffort) {
        body.reasoning_effort = 'low';
    }

    let res;
    try {
        res = await fetch(OPENAI_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal,
        });
    } catch (err) {
        if (err?.name === 'AbortError') throw err;
        throw new Error('无法连接 OpenAI 接口，请检查网络或代理设置');
    }

    const data = await res.json().catch(() => null);
    if (!res.ok) {
        const err = new Error(formatApiError(res.status, data));
        err.status = res.status;
        err.errData = data;
        throw err;
    }
    return data;
}

/**
 * Recognize task(s) from an uploaded/pasted image file.
 * Returns { tasks: string[], model: string }.
 */
export async function recognizeTasksFromImage(file, { apiKey = getOpenAIApiKey(), now = new Date(), signal } = {}) {
    const cleanKey = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!cleanKey) {
        const err = new Error('请先在设置中填写 ChatGPT API Key');
        err.code = 'NO_API_KEY';
        throw err;
    }

    const imageDataUrl = await fileToVisionDataUrl(file);
    const systemPrompt = buildSystemPrompt(now);
    const candidates = [DEFAULT_VISION_MODEL, ...FALLBACK_VISION_MODELS];

    let lastError = null;
    for (let i = 0; i < candidates.length; i++) {
        const model = candidates[i];
        try {
            let data;
            try {
                data = await callVisionOnce({
                    apiKey: cleanKey,
                    model,
                    systemPrompt,
                    imageDataUrl,
                    signal,
                    includeReasoningEffort: true,
                });
            } catch (err) {
                const msg = String(err?.errData?.error?.message || '').toLowerCase();
                if (err.status === 400 && msg.includes('reasoning_effort')) {
                    data = await callVisionOnce({
                        apiKey: cleanKey,
                        model,
                        systemPrompt,
                        imageDataUrl,
                        signal,
                        includeReasoningEffort: false,
                    });
                } else {
                    throw err;
                }
            }

            const content = extractMessageText(data);
            const tasks = parseRecognizedTasks(content, now);
            return { tasks, model };
        } catch (err) {
            if (err?.name === 'AbortError') throw err;
            lastError = err;
            if (i < candidates.length - 1 && shouldFallbackModel(err.status, err.errData)) {
                continue;
            }
            throw err;
        }
    }

    throw lastError || new Error('图片识别失败');
}
