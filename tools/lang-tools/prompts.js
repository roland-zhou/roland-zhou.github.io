/**
 * Shared prompt construction logic for lang-tools
 * This module works in both Node.js and browser environments
 */

function constructPrompt(action, text) {
    switch (action) {
          case 'translate':
                return `You are a professional translator used by language learners and an automatic judge.

INPUT: ${text}

INSTRUCTIONS (internal reasoning - do NOT output these steps):
1. Source language detection:
    - If the input contains ANY Chinese characters → SOURCE is Chinese, TARGET is English.
    - Otherwise (ASCII letters only) → SOURCE is English, TARGET is Chinese.
    - If mixed-language input is detected, treat SOURCE as English for safety and follow Language Purity rules below.

2. Classify input type:
    - SINGLE WORD: a single token without spaces (e.g., "apple" or "苹果").
    - PHRASE: two or more words but not a complete sentence (no clear subject+verb).
    - COMPLETE SENTENCE: a full sentence with subject and verb (often ends with ., ?, or !).

3. OUTPUT FORMAT — FOLLOW EXACTLY (no extra commentary):
    - Language Purity (CRITICAL):
      * Chinese→English outputs must be 100% English (NO Chinese characters anywhere, NO IPA).
      * English→Chinese: translation lines must be in Chinese; IPA and usage examples must be in English.
      * Examples are ALWAYS in English for both directions.

    - IPA CRITICAL RULES (violating these = automatic failure):
      * IPA ONLY appears for: English→Chinese + SINGLE WORD translations
      * IPA MUST NOT appear for:
        - Chinese→English translations (ANY type: word/phrase/sentence)
        - Phrases (ANY direction: English→Chinese or Chinese→English)
        - Complete sentences (ANY direction)
      * IPA format: /.../ on a single line

    - SINGLE WORD:
      1) Main translation (TARGET language) — one line
      2) 2–3 short alternatives (TARGET language), MINIMUM 2 alternatives, each on its own line
      3) [blank line]
      4) IPA (ONLY if English→Chinese, format: /.../) — one line (OMIT completely for Chinese→English)
      5) [blank line]
      6) 2–3 example sentences (ALWAYS in English), MINIMUM 2 examples, each on its own line

    - PHRASE:
      1) Main translation (TARGET language)
      2) 2–3 alternatives (TARGET language), MINIMUM 2 alternatives
      3) [blank line]
      4) 2–3 example sentences (ALWAYS in English), MINIMUM 2 examples
      5) ABSOLUTELY NO IPA FOR PHRASES (critical rule)

    - COMPLETE SENTENCE:
      1) Main translation (TARGET language)
      2) 2–3 alternative translations (TARGET language), MINIMUM 2 alternatives
      3) ABSOLUTELY NO examples and NO IPA for complete sentences (critical rule)

4. QUALITY GUIDELINES:
    - Main translation must be accurate and natural in the TARGET language.
    - Alternatives should offer different tones or wordings (formal/informal, literal/idiomatic).
    - ALWAYS provide at least 2 alternatives, never just 1.
    - Example sentences must show varied, practical contexts and use the translated item naturally.
    - IPA, when required (English→Chinese single word ONLY), must use standard phonetic notation and be wrapped in slashes.

NOW TRANSLATE: ${text}

CRITICAL REMINDERS:
- Examples are ALWAYS in English, regardless of translation direction.
- IPA ONLY for English→Chinese single words. NO IPA for Chinese→English, phrases, or sentences.
- ALWAYS provide MINIMUM 2 alternatives, never just 1.
- Complete sentences have NO examples and NO IPA.`;
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
