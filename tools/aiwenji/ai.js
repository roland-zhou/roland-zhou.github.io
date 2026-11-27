/**
 * ai问记 AI Client & Card Splitter (OpenAI & DeepSeek Chat Completions).
 * Exact port of AIClient.swift, AIService.swift, and CardSplitter.swift.
 */

import { DEFAULT_SPLIT_PROMPT, getApiToken, getProvider, resolveModel, uid } from './model.js';

export const DEFAULT_ASK_INSTRUCTION =
    '开门见山，先给答案。默认用 1–3 句话，只写回答问题所必需的内容。' +
    '省去寒暄、复述和总结，除非有助于理解，否则不用标题或列表。用户要求详细内容时，按要求展开。';

export const SPLIT_OUTPUT_FORMAT_INSTRUCTION = [
    '只输出 JSON 数组，不要输出任何解释文字，也不要用 Markdown 代码块包裹。',
    '数组每一项是一个对象，包含两个字段：',
    '"front" 是要回忆的提示，"back" 是答案和说明。',
    '每张卡片只覆盖一个知识点，最多拆成 5 张。',
    '"back" 里的换行写成 \\n。',
].join('\n');

export class AIError extends Error {
    constructor(code, message, status = 0) {
        super(message);
        this.name = 'AIError';
        this.code = code;
        this.status = status;
    }
}

export function buildAskMessages(instruction, input) {
    const trimmedInstruction = typeof instruction === 'string' ? instruction.trim() : '';
    const effective = trimmedInstruction || DEFAULT_ASK_INSTRUCTION;
    return [
        { role: 'system', content: effective },
        { role: 'user', content: String(input || '').trim() },
    ];
}

function buildRequestBody(providerId, model, messages, includeDisableThinking = true) {
    const body = {
        model,
        messages,
        stream: false,
    };
    if (includeDisableThinking) {
        if (providerId === 'openai') {
            body.reasoning_effort = 'none';
        } else if (providerId === 'deepseek') {
            body.thinking = { type: 'disabled' };
        }
    }
    return body;
}

function extractResponseContent(data) {
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
        return content
            .map(part => (typeof part === 'string' ? part : (part?.text || '')))
            .join('\n')
            .trim();
    }
    return '';
}

function formatHttpError(status, errData) {
    const msg = typeof errData?.error?.message === 'string' ? errData.error.message.trim() : '';
    if (status === 401) return msg ? `请求失败（HTTP 401）：${msg}` : 'API Token 无效或已过期，请检查设置。';
    if (status === 403) return msg ? `请求失败（HTTP 403）：${msg}` : '无权访问该模型或当前网络区域受限。';
    if (status === 429) return msg ? `请求失败（HTTP 429）：${msg}` : '请求过于频繁或额度不足，请稍后再试。';
    return msg ? `请求失败（HTTP ${status}）：${msg}` : `请求失败（HTTP ${status}）`;
}

async function callChatOnce({ provider, token, model, messages, signal, includeDisableThinking }) {
    const body = buildRequestBody(provider.id, model, messages, includeDisableThinking);
    let res;
    try {
        res = await fetch(provider.chatCompletionsURL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(body),
            signal,
        });
    } catch (err) {
        if (err?.name === 'AbortError') throw err;
        throw new AIError('transport', `网络错误：${err?.message || '无法连接 AI 服务，请检查网络或代理设置'}`);
    }

    const data = await res.json().catch(() => null);
    if (!res.ok) {
        const err = new AIError('http', formatHttpError(res.status, data), res.status);
        err.errData = data;
        throw err;
    }

    const content = extractResponseContent(data);
    if (!content) {
        throw new AIError('invalidResponse', '返回内容无法解析。');
    }
    return content;
}

export async function completeChat({ providerId, model, messages, token, signal }) {
    const provider = getProvider(providerId);
    const cleanToken = typeof token === 'string' ? token.trim() : getApiToken(provider.id);
    if (!cleanToken) {
        throw new AIError('missingToken', `还没有为 ${provider.displayName} 保存 API Token。`);
    }

    try {
        return await callChatOnce({
            provider,
            token: cleanToken,
            model,
            messages,
            signal,
            includeDisableThinking: true,
        });
    } catch (err) {
        // Gracefully retry without provider-specific non-thinking param if a selected model rejects it.
        const rawMsg = String(err?.errData?.error?.message || '').toLowerCase();
        if (err?.status === 400 && (rawMsg.includes('reasoning_effort') || rawMsg.includes('thinking'))) {
            return await callChatOnce({
                provider,
                token: cleanToken,
                model,
                messages,
                signal,
                includeDisableThinking: false,
            });
        }
        throw err;
    }
}

export async function askAI({ settings, instruction = null, input, signal }) {
    const trimmed = String(input || '').trim();
    if (!trimmed) throw new AIError('emptyInput', '请先输入内容。');
    const provider = getProvider(settings.provider);
    const model = resolveModel(provider.id, settings.modelsByProvider);
    const messages = buildAskMessages(instruction, trimmed);
    return await completeChat({ providerId: provider.id, model, messages, signal });
}

export async function testAIConnection({ settings, token }) {
    const provider = getProvider(settings.provider);
    const model = resolveModel(provider.id, settings.modelsByProvider);
    await completeChat({
        providerId: provider.id,
        model,
        token,
        messages: [{ role: 'user', content: 'ping' }],
    });
    return '连接正常';
}

/* ---------- CardSplitter (Exact Port of CardSplitter.swift) ---------- */

export const CardSplitter = {
    instruction(userPrompt) {
        const semantics = typeof userPrompt === 'string' ? userPrompt.trim() : '';
        return `${semantics || DEFAULT_SPLIT_PROMPT}\n\n${SPLIT_OUTPUT_FORMAT_INSTRUCTION}`;
    },

    exchangeInput(question, answer) {
        return `请拆分下面这一轮问答：\n\n用户问题：\n${question}\n\nAI 回复：\n${answer}`;
    },

    extractJSONArray(text) {
        let body = String(text || '').trim();
        if (body.startsWith('```')) {
            const lines = body.split(/\r?\n/);
            const inner = [];
            for (let i = 1; i < lines.length; i++) {
                if (lines[i].trim().startsWith('```')) break;
                inner.push(lines[i]);
            }
            body = inner.join('\n');
        }
        const start = body.indexOf('[');
        const end = body.lastIndexOf(']');
        if (start < 0 || end <= start) return null;
        return body.slice(start, end + 1);
    },

    parse(text) {
        const json = this.extractJSONArray(text);
        if (!json) return [];
        let raw;
        try {
            raw = JSON.parse(json);
        } catch {
            return [];
        }
        if (!Array.isArray(raw)) return [];
        const out = [];
        for (const item of raw) {
            const front = typeof item?.front === 'string' ? item.front.trim() : '';
            if (!front) continue;
            const back = typeof item?.back === 'string' ? item.back.trim() : '';
            out.push({
                id: uid(),
                front,
                back,
                savedCardID: null,
            });
        }
        return out;
    },
};
