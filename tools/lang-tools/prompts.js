/**
 * Shared prompt construction logic for lang-tools
 * This module works in both Node.js and browser environments
 */

function constructPrompt(action, text) {
    switch (action) {
          case 'translate':
                const hasChineseChars = /[\u4e00-\u9fa5]/.test(text);
                const isSentence = text.includes('。') || text.includes('.') || text.includes('?') || text.includes('？') || text.includes('!') || text.includes('！') || /\s.+\s/.test(text);
                const isPhrase = text.includes(' ') && !isSentence;

                if (hasChineseChars) {
                    // Chinese to English
                    if (isSentence) {
                        return `Translate this Chinese sentence to English. Provide 3 different English translations that express the SAME core meaning but with different tones/word choices. Keep the essential meaning intact - only vary formality, intensity, or wording.

Input: ${text}

Output exactly 3 lines:
Line 1: first English translation (natural, direct)
Line 2: second English translation (same meaning, different word choice or tone)
Line 3: third English translation (same meaning, different word choice or tone)

IMPORTANT: All 3 translations must express the same core idea as "${text}" - only vary the style/tone/wording, NOT the fundamental meaning.`;
                    } else if (isPhrase) {
                        return `Translate this Chinese phrase to English. Output exactly 7 lines as shown below. NO IPA.

Input: ${text}

Required output format (copy this structure exactly):
first English translation
second English translation (different wording)
third English translation (different wording)
[empty line - press enter but write nothing]
first example sentence using the phrase in English
second example sentence using the phrase in English
third example sentence using the phrase in English`;
                    } else {
                        return `Translate this Chinese word to English. Provide 3 REAL, VALID English words/terms. Use actual English synonyms or related terms.

Input: ${text}

Required output format (copy this structure exactly):
main English translation (most common real word)
alternative English word (real, valid, commonly used)
alternative English word (real, valid, can be more formal/informal)
[empty line - press enter but write nothing]
first example sentence using the word in English
second example sentence using the word in English
third example sentence using the word in English

IMPORTANT: All English translations MUST be real, valid words that actually exist.`;
                    }
                } else {
                    // English to Chinese
                    if (isSentence) {
                        return `Translate this English sentence to Chinese. Provide 3 different Chinese translations that express the SAME core meaning but with different tones/word choices. Keep the essential meaning intact - only vary formality, intensity, or wording.

Input: ${text}

Output exactly 3 lines:
Line 1: first Chinese translation (natural, direct)
Line 2: second Chinese translation (same meaning, different word choice or tone)
Line 3: third Chinese translation (same meaning, different word choice or tone)

IMPORTANT: All 3 translations must express the same core idea as "${text}" - only vary the style/tone/wording, NOT the fundamental meaning.`;
                    } else if (isPhrase) {
                        return `Translate this English phrase to Chinese. Provide 3 Chinese translations, then 3 English example sentences that demonstrate the FIRST/main translation's usage.

Input: ${text}

Required output format (copy this structure exactly):
first Chinese translation (most common/versatile meaning)
second Chinese translation (alternative meaning or context)
third Chinese translation (alternative meaning or context)
[empty line - press enter but write nothing]
first example sentence - demonstrates the FIRST translation's meaning in English
second example sentence - demonstrates the FIRST translation's meaning in English
third example sentence - demonstrates the FIRST translation's meaning in English

IMPORTANT: The example sentences should primarily illustrate how "${text}" is used in contexts that match the FIRST Chinese translation.`;
                    } else {
                        return `Translate this English word to Chinese. Provide 3 REAL, VALID Chinese words/terms that exist in the language. Do NOT fabricate or invent words. Use actual Chinese synonyms or related terms.

Input: ${text}

Required output format (copy this structure exactly):
main Chinese translation (most common real word)
alternative Chinese word (real, valid, commonly used)
alternative Chinese word (real, valid, can be more formal/informal/literary)
[empty line - press enter but write nothing]
/IPA phonetic transcription of the ENGLISH word "${text}", like /ˈæpl/ - transcribe the ENGLISH pronunciation, NOT the Chinese/
[empty line - press enter but write nothing]
first example sentence using the word in English
second example sentence using the word in English
third example sentence using the word in English

CRITICAL: The IPA must transcribe how to pronounce the ENGLISH word "${text}", NOT the Chinese translation. Use IPA phonetic symbols, NOT pinyin. Example: for "apple" use /ˈæpl/, NOT /píng guǒ/ or /ˈpʰiŋ.kwɔ/.`;
                    }
                }
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
