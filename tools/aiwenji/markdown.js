/**
 * Lightweight, XSS-safe Markdown renderer & plainText extractor for ai问记.
 * Mirrors MarkdownDocument.swift: headings, paragraphs, bullet/ordered/task lists,
 * blockquotes, fenced code blocks, dividers, and inline bold/italic/code/strike/links.
 */

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function safeUrl(raw) {
    try {
        const u = new URL(raw, 'https://example.com');
        if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') {
            return raw;
        }
    } catch { /* ignore */ }
    return null;
}

function renderInline(text) {
    // Protect inline code spans first so markdown syntax inside code is untouched.
    const codeSlots = [];
    let working = String(text || '').replace(/`([^`\n]+)`/g, (_, code) => {
        const idx = codeSlots.length;
        codeSlots.push(`<code>${escapeHtml(code)}</code>`);
        return `\u0000CODE${idx}\u0000`;
    });

    working = escapeHtml(working);

    // Links: [label](url)
    working = working.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
        const safe = safeUrl(url.replace(/&amp;/g, '&'));
        if (!safe) return label;
        return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });

    // Bold + Italic, Bold, Italic, Strikethrough
    working = working.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    working = working.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    working = working.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    working = working.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    working = working.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

    // Restore inline code
    working = working.replace(/\u0000CODE(\d+)\u0000/g, (_, idx) => codeSlots[Number(idx)] || '');
    // Preserve soft line breaks inside paragraphs/items
    working = working.replace(/\n/g, '<br>');
    return working;
}

function stripInlineMarkdown(text) {
    return String(text || '')
        .replace(/`([^`\n]+)`/g, '$1')
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1')
        .replace(/\*\*\*([^*\n]+)\*\*\*/g, '$1')
        .replace(/\*\*([^*\n]+)\*\*/g, '$1')
        .replace(/__([^_\n]+)__/g, '$1')
        .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
        .replace(/~~([^~\n]+)~~/g, '$1');
}

function fenceMarker(trimmed) {
    if (trimmed.startsWith('```')) return '`';
    if (trimmed.startsWith('~~~')) return '~';
    return null;
}

function isThematicBreak(trimmed) {
    const compact = trimmed.replace(/\s+/g, '');
    if (compact.length < 3) return false;
    const ch = compact[0];
    if (ch !== '-' && ch !== '*' && ch !== '_') return false;
    for (let i = 1; i < compact.length; i++) {
        if (compact[i] !== ch) return false;
    }
    return true;
}

function parseHeading(trimmed) {
    const m = trimmed.match(/^(#{1,6})(?:\s+(.*))?$/);
    if (!m) return null;
    const text = (m[2] || '').replace(/\s+#+\s*$/, '').trim();
    return { type: 'heading', level: m[1].length, text };
}

function leadingIndentWidth(line) {
    let w = 0;
    for (const ch of line) {
        if (ch === ' ') w += 1;
        else if (ch === '\t') w += 4;
        else break;
    }
    return w;
}

function parseListItem(line) {
    const indentWidth = leadingIndentWidth(line);
    const rest = line.replace(/^[ \t]+/, '');
    const bulletMatch = rest.match(/^([-*+])[ \t]+(.*)$/);
    if (bulletMatch) {
        let text = bulletMatch[2].trim();
        let marker = { kind: 'bullet' };
        const taskMatch = text.match(/^\[([ xX])\]\s*(.*)$/);
        if (taskMatch) {
            marker = { kind: 'task', done: taskMatch[1].toLowerCase() === 'x' };
            text = taskMatch[2];
        }
        return { marker, indent: Math.min(Math.floor(indentWidth / 2), 3), text };
    }
    const orderedMatch = rest.match(/^(\d{1,9})[.)][ \t]+(.*)$/);
    if (orderedMatch) {
        return {
            marker: { kind: 'ordered', num: Number(orderedMatch[1]) || 1 },
            indent: Math.min(Math.floor(indentWidth / 2), 3),
            text: orderedMatch[2].trim(),
        };
    }
    return null;
}

function parseLines(lines) {
    const blocks = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed) {
            i += 1;
            continue;
        }

        const fence = fenceMarker(trimmed);
        if (fence) {
            const language = trimmed.slice(3).trim();
            const indent = leadingIndentWidth(line);
            i += 1;
            const codeLines = [];
            while (i < lines.length) {
                if (fenceMarker(lines[i].trim()) === fence) {
                    i += 1;
                    break;
                }
                const drop = Math.min(indent, leadingIndentWidth(lines[i]));
                codeLines.push(lines[i].slice(drop));
                i += 1;
            }
            blocks.push({ type: 'code', language, content: codeLines.join('\n') });
            continue;
        }

        if (isThematicBreak(trimmed)) {
            blocks.push({ type: 'divider' });
            i += 1;
            continue;
        }

        const heading = parseHeading(trimmed);
        if (heading) {
            blocks.push(heading);
            i += 1;
            continue;
        }

        if (trimmed.startsWith('>')) {
            const inner = [];
            while (i < lines.length && lines[i].trim().startsWith('>')) {
                let c = lines[i].trim().slice(1);
                if (c.startsWith(' ')) c = c.slice(1);
                inner.push(c);
                i += 1;
            }
            blocks.push({ type: 'quote', blocks: parseLines(inner) });
            continue;
        }

        if (parseListItem(line)) {
            const items = [];
            while (i < lines.length) {
                const cur = lines[i];
                const t = cur.trim();
                if (!t) {
                    const nextNonEmpty = lines.slice(i + 1).find(l => l.trim().length > 0);
                    if (!nextNonEmpty || !parseListItem(nextNonEmpty)) break;
                    i += 1;
                    continue;
                }
                const item = parseListItem(cur);
                if (item) {
                    items.push(item);
                    i += 1;
                } else if (items.length && leadingIndentWidth(cur) >= 2) {
                    items[items.length - 1].text += `\n${t}`;
                    i += 1;
                } else {
                    break;
                }
            }
            blocks.push({ type: 'list', items });
            continue;
        }

        // Paragraph
        const para = [];
        while (i < lines.length) {
            const cur = lines[i];
            const t = cur.trim();
            if (!t) break;
            if (para.length > 0) {
                if (fenceMarker(t) || isThematicBreak(t) || parseHeading(t) || t.startsWith('>') || parseListItem(cur)) {
                    break;
                }
            }
            para.push(t);
            i += 1;
        }
        blocks.push({ type: 'paragraph', text: para.join('\n') });
    }

    return blocks;
}

export function parseMarkdown(text) {
    const normalized = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return parseLines(normalized.split('\n'));
}

function renderBlocks(blocks) {
    return blocks.map((block) => {
        switch (block.type) {
            case 'heading': {
                const lvl = Math.min(6, Math.max(1, block.level));
                return `<h${lvl} class="md-h md-h${lvl}">${renderInline(block.text)}</h${lvl}>`;
            }
            case 'paragraph':
                return `<p class="md-p">${renderInline(block.text)}</p>`;
            case 'divider':
                return '<hr class="md-hr">';
            case 'code':
                return `<pre class="md-code"><code>${escapeHtml(block.content)}</code></pre>`;
            case 'quote':
                return `<blockquote class="md-quote">${renderBlocks(block.blocks)}</blockquote>`;
            case 'list': {
                const itemsHtml = block.items.map((item) => {
                    const pad = item.indent * 16;
                    let markerHtml = '<span class="md-marker">•</span>';
                    if (item.marker.kind === 'ordered') {
                        markerHtml = `<span class="md-marker">${item.marker.num}.</span>`;
                    } else if (item.marker.kind === 'task') {
                        markerHtml = `<span class="md-marker">${item.marker.done ? '☑' : '☐'}</span>`;
                    }
                    return `<li class="md-li" style="padding-left:${pad}px">${markerHtml}<span class="md-li-body">${renderInline(item.text)}</span></li>`;
                }).join('');
                return `<ul class="md-list">${itemsHtml}</ul>`;
            }
            default:
                return '';
        }
    }).join('');
}

export function renderMarkdown(text) {
    return renderBlocks(parseMarkdown(text));
}

function blockToPlainText(block) {
    switch (block.type) {
        case 'heading':
        case 'paragraph':
            return stripInlineMarkdown(block.text);
        case 'list':
            return block.items.map(it => stripInlineMarkdown(it.text)).join('\n');
        case 'quote':
            return block.blocks.map(blockToPlainText).filter(Boolean).join('\n');
        case 'code':
            return block.content;
        case 'divider':
        default:
            return '';
    }
}

export function markdownPlainText(text) {
    return parseMarkdown(text)
        .map(blockToPlainText)
        .filter(Boolean)
        .join('\n');
}
