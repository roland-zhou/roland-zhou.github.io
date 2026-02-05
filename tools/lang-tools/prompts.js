/**
 * Shared prompt construction logic for lang-tools
 * This module works in both Node.js and browser environments
 */

function constructPrompt(action, text) {
    switch (action) {
        case 'translate':
            return `You are a professional translator. Translate the following text.

**Step 1: Detect Language**
- English input → Translate to Simplified Chinese
- Chinese input → Translate to English

**Step 2: Output Format**

If input is a SINGLE WORD (e.g., "apple", "快乐"):
Line 1: Main translation
Line 2-3: Alternative translations (2-3 options)
[blank line]
Line: IPA pronunciation (ONLY if translating FROM English)
[blank line]
Last 2-3 lines: Usage example sentences in the TARGET language

If input is a PHRASE (2+ words, not a sentence, e.g., "cold brew", "加油站"):
Line 1: Main translation
Line 2-3: Alternative translations
[blank line]
Last 2-3 lines: Usage examples in TARGET language

If input is a COMPLETE SENTENCE (has subject + verb):
Line 1: Main translation ONLY
(Stop here. No alternatives, no examples.)

**CRITICAL RULES - READ CAREFULLY:**
1. Output ONLY in the TARGET language (if input is Chinese → output 100% English, if input is English → output 100% Chinese)
2. NEVER mix source language and target language in your output
3. NEVER repeat or echo the input text
4. NEVER add labels like "Translation:", "Alternatives:", "Examples:"
5. Start directly with the translated text
6. Usage examples should use the translated word/phrase naturally in sentences

**Example 1 (Chinese → English, single word):**
Input: 赶快
Output:
Hurry up
Quickly
Fast

Hurry up or we'll be late!
Please finish your homework quickly.
We need to leave fast.

**Example 2 (English → Chinese, phrase):**
Input: cold brew
Output:
冷萃咖啡
冷泡咖啡

我喜欢喝冷萃咖啡。
这家店的冷泡咖啡很好喝。

**Example 3 (Complete sentence):**
Input: I like coffee.
Output:
我喜欢咖啡。

---
Text to translate: ${text}`;
        case 'rewrite':
            return `I'm an English learner whose mother language is Chinese.
Please rewrite the following text (which may contain Chinglish, grammar errors, or unnatural phrasing) into natural, high-quality English.

You MUST follow this format exactly:

Casual: [Natural, spoken-style version OR "(don't need to rewrite it)"]
Formal: [Polite, professional version OR "(don't need to rewrite it)"]

Analysis:
[If there were errors or unnatural phrasing, explain them here. If the input was valid and common, OMIT this section.]

**Important Rules:**
1. Always check for common Chinese learner mistakes (grammar, Chinglish).
2. If the input is already natural for that specific style (Casual or Formal), or if the rewritten version is identical to the input, output "(don't need to rewrite it)".
3. Do not include an Analysis section if the input is valid/common English.

Example 1 (Grammar Error):
<INPUT>
Do you like apple?
</INPUT>
<OUTPUT>
Casual: Do you like apples?
Formal: Do you care for apples?

Analysis:
"Apple" is a countable noun. Use plural "apples" for general preference.
</OUTPUT>

Example 2 (Common/Valid Phrase):
<INPUT>
All good
</INPUT>
<OUTPUT>
Casual: (don't need to rewrite it)
Formal: All is well.
</OUTPUT>

Example 3 (Universal/Perfect Phrase):
<INPUT>
I love you.
</INPUT>
<OUTPUT>
Casual: (don't need to rewrite it)
Formal: (don't need to rewrite it)
</OUTPUT>

<text-to-be-rewritten>${text}</text-to-be-rewritten>`;
        case 'explain':
            return `Explain the meaning, grammar, and usage of the following text or concept in simple terms.
Strictly only output the explanation content, without markdown formatting, but can use simple line breaks to separate different points.

<text-to-be-explained>${text}</text-to-be-explained>`;
        default:
            return text;
    }
}

// Export for Node.js (CommonJS)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { constructPrompt };
}

// Export for browser (global)
if (typeof window !== 'undefined') {
    window.constructPrompt = constructPrompt;
}
