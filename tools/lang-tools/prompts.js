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
- If the text contains only emojis or symbols, interpret and translate to English.

**OUTPUT FORMAT RULES (Strictly Follow):**

**Scenario A: Input is a Word or Phrase (Fragment)**
(e.g., "apple", "cold brew", "keep in mind", "take off")
Output structure:
1. Main translation
2. Alternative translations (2-3 lines)
3. [Empty Line]
4. Pronunciation (IPA) - ONLY for single English words. OMIT for phrases/Chinese input.
5. [Empty Line]
6. Usage Examples (2-3 sentences showing the input in context)

**Scenario B: Input is a Complete Sentence**
(e.g., "I went home.", "The coffee is cold.")
Output structure:
1. Main translation
2. Alternative translations
(STOP HERE. No pronunciation, no examples.)

**CRITICAL NEGATIVE CONSTRAINTS:**
- NEVER output explanations like "This is a phrase" or "This is a sentence".
- NEVER explain grammar or why you chose a format.
- NEVER include XML tags like <OUTPUT> or </OUTPUT> in your response. Just the raw text.
- JUST OUTPUT THE CONTENT.

**How to decide:**
- If it lacks a subject AND a main verb, treat it as a **Phrase (Scenario A)** -> PROVIDE EXAMPLES.
- If it's just a noun (e.g., "tonic cold brew"), it is a **Phrase (Scenario A)** -> PROVIDE EXAMPLES.

**Example 1 (Single Word):**
Input: apple
Output:
苹果
[noun] 苹果树

/ˈæp.əl/

I ate a delicious apple.
An apple a day keeps the doctor away.

**Example 2 (Phrase):**
Input: tonic cold brew
Output:
汤力冷萃咖啡
汤力水冷萃
气泡冷萃

I ordered a refreshing tonic cold brew at the cafe.
Tonic cold brew is perfect for a hot summer day.
Have you ever tried mixing tonic water with cold brew coffee?

**Example 3 (Sentence):**
Input: I like coffee.
Output:
我喜欢咖啡。
我很爱喝咖啡。
咖啡是我的最爱。

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
