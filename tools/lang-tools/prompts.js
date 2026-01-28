/**
 * Shared prompts module for lang-tools
 * Can be used by both browser and Node.js environments
 */

const PROMPTS = {
    translate: (text) => `Translate the following text.
If it contains any non-English content, translate the whole text into English.
If it is entirely in Chinese, translate the whole text into English.
If it is entirely in English, translate the whole text into Chinese.

Except the translation, please always provide 2-3 alternative translations.
Output only the translated content without any markdown formatting or explanations.

<text-to-be-translated>${text}</text-to-be-translated>`,

    rewrite: (text) => `I'm an English learner who's mother language is Chinese.
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

<text-to-be-rewritten>${text}</text-to-be-rewritten>`,

    explain: (text) => `Explain the meaning, grammar, and usage of the following text or concept in simple terms.
Strictly only output the explanation content, without markdown formatting, but can use simple line breaks to separate different points.

<text-to-be-explained>${text}</text-to-be-explained>`
};

// Export for Node.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PROMPTS };
}
