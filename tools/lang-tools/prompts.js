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

STEP 2: Classify input type
- SINGLE WORD: One word only (e.g., "apple" or "苹果")
- PHRASE: 2+ words, but NOT a complete sentence (e.g., "break down" or "弹窗")
- COMPLETE SENTENCE: Has subject + verb, forms complete thought (e.g., "I like coffee")

STEP 3: Output format - FOLLOW EXACTLY:

🎯 CRITICAL RULE - EXAMPLE LANGUAGE:
- Chinese → English: Examples must be 100% ENGLISH
- English → Chinese: Translation in Chinese, BUT examples must be 100% ENGLISH
- NO EXCEPTIONS: Examples are ALWAYS in English regardless of translation direction

For SINGLE WORDS:
1. Main translation (TARGET language)
2. 2-3 alternatives (TARGET language)
3. [blank line]
4. IPA (ONLY for English→Chinese, format: /.../)
5. [blank line]
6. 2-3 example sentences (ALWAYS ENGLISH)

For PHRASES:
1. Main translation (TARGET language)
2. 2-3 alternatives (TARGET language)
3. [blank line]
4. 2-3 example sentences (ALWAYS ENGLISH)
5. NO IPA for phrases

For COMPLETE SENTENCES:
1. Main translation (TARGET language)
2. 2-3 alternative translations (TARGET language)
3. NO examples, NO IPA

EXAMPLES:

Example A - Chinese word → English:
Input: 弹窗
Output:
Pop-up window
Pop-up
Modal dialog

Please close this pop-up window.
Too many pop-ups are blocking the content.
The modal dialog requires your attention.

Example B - English word → Chinese (NOTE: examples in English!):
Input: apple
Output:
苹果
水果苹果
苹果树的果实

/ˈæp.əl/

I eat an apple every day.
This apple tastes sweet and crisp.
An apple a day keeps the doctor away.

Example C - Chinese sentence → English:
Input: 我喜欢咖啡。
Output:
I like coffee.
I love coffee.
Coffee is my favorite.

Example D - English phrase → Chinese (NOTE: examples in English!):
Input: break down
Output:
分解
拆解
故障

The machine broke down yesterday.
We need to break down this problem.
His car breaks down frequently.

NOW TRANSLATE: ${text}

REMINDER: Examples are ALWAYS in English, no matter which direction you're translating!`;
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
