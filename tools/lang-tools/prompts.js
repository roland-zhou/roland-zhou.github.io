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
            return `I'm an English learner who's mother language is Chinese.
Please rewrite the following Chinglish text into good English.
Please show one casual version and one formal version to fit different scenarios.
If it already fits one of the two styles, please keep it as it is and don't force rewrite it.
Strictly only output the rewritten content, without markdown formatting.

Example:
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
