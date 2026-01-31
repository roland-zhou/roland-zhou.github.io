/**
 * Shared prompt construction logic for lang-tools
 * This module works in both Node.js and browser environments
 */

function constructPrompt(action, text) {
    switch (action) {
        case 'translate':
            return `Translate the following text between English and Chinese.
First, detect the language of the text:
- If the text is entirely in English, you MUST translate it into Chinese (Simplified Chinese).
- If the text contains any Chinese, you MUST translate it into English.
- If the text contains only emojis or symbols (no natural language), you MUST interpret and translate it into English.

Provide the main translation first, then 2-3 alternative translations in the same target language.
Output only the translations without any markdown formatting, labels, or explanations.

<text-to-be-translated>${text}</text-to-be-translated>`;
        case 'rewrite':
            return `I'm an English learner whose mother language is Chinese.
Please rewrite the following text (which may contain Chinglish, grammar errors, or unnatural phrasing) into natural, high-quality English.

You MUST follow this format exactly:

Casual: [Natural, spoken-style version]
Formal: [Polite, professional version]

Analysis:
[If there were ANY errors (grammar, countable/uncountable nouns, Chinglish) or unnatural phrasing, explain them here. If the input was 100% perfect, omit this section.]

**Important Rules:**
1. Always check for common Chinese learner mistakes (e.g., noun plurality "apple" vs "apples", verb tenses, "I very like").
2. Even if the input is grammatically correct but awkward, rewrite it and explain why in Analysis.
3. Do not just echo the input unless it is already perfect English.

Example 1 (Grammar Error):
<INPUT>
Do you like apple?
</INPUT>
<OUTPUT>
Casual: Do you like apples?
Formal: Do you care for apples?

Analysis:
"Apple" is a countable noun. When talking about the fruit in general, you should use the plural form "apples". "Do you like apple?" sounds like you are asking about apple flavor or substance, which is rare.
</OUTPUT>

Example 2 (Chinglish):
<INPUT>
I very like it.
</INPUT>
<OUTPUT>
Casual: I really like it.
Formal: I am quite fond of it.

Analysis:
"Very like" is incorrect. Use "really like" or "like it very much".
</OUTPUT>

Example 3 (Perfect Input):
<INPUT>
Good job!
</INPUT>
<OUTPUT>
Casual: Good job!
Formal: Excellent work.
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
