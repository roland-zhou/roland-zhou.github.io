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
Please rewrite the following text (which may contain Chinglish or errors) into natural, high-quality English.

Output Structure:
1. Provide one Casual version.
2. Provide one Formal version.
3. If the original input had grammar mistakes or "Chinglish" phrasing, add a concise "Analysis:" section at the end explaining *why* it was incorrect and how to fix it. If the input was already perfect, omit this section.

Strictly output only the content (Casual, Formal, Analysis) without extra conversational filler.

Example 1 (With errors):
<INPUT>
I very like apple.
</INPUT>
<OUTPUT>
Casual: I really like apples.
Formal: I am quite fond of apples.

Analysis:
"I very like" is a common mistake. In English, we use "really" or "very much" to modify verbs like "like". Also, "apple" is countable, so use plural "apples" for general preference.
</OUTPUT>

Example 2 (No errors):
<INPUT>
Good work!
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
