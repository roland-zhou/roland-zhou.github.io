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

**Additional content based on input type:**
- Single English word: Add pronunciation in IPA format + 2-3 usage examples showing the word in context
- Single Chinese word: Add 2-3 usage examples only (DO NOT ADD PRONUNCIATION - NO IPA, NO PINYIN)
- Phrase (2-5 words): Add 2-3 usage examples only (no pronunciation)
- Sentence/long string: No additional content

**CRITICAL RULE FOR CHINESE INPUT:**
If the input contains ANY Chinese characters, DO NOT include ANY pronunciation line. Skip directly from translations to examples.

**IMPORTANT formatting rules:**
- Add ONE empty line between translations and pronunciation (English words only)
- Add ONE empty line between pronunciation and usage examples
- Add ONE empty line between each section

Output only the translations without any markdown formatting, labels, or explanations.

**Example 1 (Single Word):**
<INPUT>
apple
</INPUT>
<OUTPUT>
苹果
苹果派
红苹果

/ˈæpəl/

I ate an apple for breakfast.
The apple tree in our garden is blooming.
She bought a bag of fresh apples.
</OUTPUT>

**Example 2 (Phrase):**
<INPUT>
keep in mind
</INPUT>
<OUTPUT>
记住
牢记
别忘了

Keep in mind that the deadline is Friday.
You should keep in mind his advice.
Please keep in mind the safety rules.
</OUTPUT>

**Example 3 (Chinese Word to English):**
<INPUT>
苹果
</INPUT>
<OUTPUT>
apple
apple pie
red apple

我吃了一个苹果。
这个苹果很甜。
苹果树开花了。
</OUTPUT>

**Example 4 (Sentence):**
<INPUT>
I went to the store yesterday.
</INPUT>
<OUTPUT>
我昨天去了商店。
昨天我去商店了。
我昨天去过那家店。
</OUTPUT>

<text-to-be-translated>${text}</text-to-be-translated>`;
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
