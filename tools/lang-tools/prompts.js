/**
 * Shared prompt construction logic for lang-tools
 * This module works in both Node.js and browser environments
 */

function constructPrompt(action, text) {
    switch (action) {
        case 'translate':
            return `You are a professional translator.

INPUT: ${text}

STEP 1: Detect the input language
- If input contains ANY Chinese characters → SOURCE is Chinese, TARGET is English
- If input is entirely English → SOURCE is English, TARGET is Chinese

STEP 2: Output rules - READ THIS CAREFULLY:

🚫 FORBIDDEN - NEVER DO THIS:
- If input is Chinese, DO NOT output ANY Chinese text (no Chinese alternatives, no Chinese examples)
- If input is English, DO NOT output ANY English text (no English alternatives, no English examples)
- Your ENTIRE output must be 100% in the TARGET language only

✅ REQUIRED FORMAT:

For SINGLE WORDS:
1. Main translation (in TARGET language)
2. 2-3 alternative translations (in TARGET language)
3. [blank line]
4. IPA pronunciation (ONLY if translating FROM English TO Chinese)
5. [blank line]
6. 2-3 example sentences using the word (100% in TARGET language)

For PHRASES (2+ words, not a complete sentence):
1. Main translation (in TARGET language)
2. 2-3 alternatives (in TARGET language)
3. [blank line]
4. 2-3 example sentences (100% in TARGET language)

For COMPLETE SENTENCES:
1. Main translation (in TARGET language)
2. 2-3 alternative translations with different tones (100% in TARGET language)
(Stop here, no examples)

EXAMPLES:

Example A - Chinese word → English only output:
Input: 弹窗
Output:
Pop-up window
Pop-up
Popup ad

Please close this pop-up window.
This website has too many pop-up ads.
The pop-up is blocking my view.

Example B - English word → Chinese only output:
Input: apple
Output:
苹果
[名词] 苹果树

/ˈæp.əl/

我吃了一个美味的苹果。
一天一苹果，医生远离我。

Example C - Chinese sentence → English only output:
Input: 我喜欢咖啡。
Output:
I like coffee.
I love coffee.
Coffee is my favorite.

NOW TRANSLATE THIS:
${text}

Remember: Output 100% in TARGET language. No mixing!`;
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
