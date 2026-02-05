/**
 * Test cases for prompt evaluation
 * Each test case contains:
 * - action: the prompt type (translate/rewrite/explain)
 * - input: the user input text
 * - expectedOutput: a good output sample (or null if we only judge by rules)
 * - description: what this test case is checking
 */

const testCases = [
    // ===== TRANSLATE TESTS =====
    {
        action: 'translate',
        input: '弹窗',
        description: 'Chinese word → English (should include alternatives and examples)',
        expectedOutput: `Pop-up window
Pop-up
Popup ad

Please close this pop-up window.
This website has too many pop-up ads.
The pop-up is blocking my view.`
    },
    {
        action: 'translate',
        input: 'apple',
        description: 'English word → Chinese (should include IPA and examples)',
        expectedOutput: `苹果
[名词] 苹果树

/ˈæp.əl/

我吃了一个美味的苹果。
一天一苹果，医生远离我。`
    },
    {
        action: 'translate',
        input: '我喜欢咖啡。',
        description: 'Chinese sentence → English (only translations, no examples)',
        expectedOutput: `I like coffee.
I love coffee.
Coffee is my favorite.`
    },
    {
        action: 'translate',
        input: 'I love programming.',
        description: 'English sentence → Chinese (only translations, no examples)',
        expectedOutput: `我热爱编程。
我喜欢写代码。
编程是我的爱好。`
    },
    {
        action: 'translate',
        input: 'break down',
        description: 'English phrase → Chinese (should have alternatives and examples)',
        expectedOutput: `分解
拆分
崩溃

这个问题可以分解成几个小步骤。
机器突然崩溃了。
让我们把这个任务拆分开来。`
    },
    
    // ===== REWRITE TESTS =====
    {
        action: 'rewrite',
        input: 'Do you like apple?',
        description: 'Grammar error (countable noun)',
        expectedOutput: `Casual: Do you like apples?
Formal: Do you care for apples?

Analysis:
"Apple" is a countable noun. Use plural "apples" for general preference.`
    },
    {
        action: 'rewrite',
        input: 'All good',
        description: 'Common casual phrase (no rewrite needed for casual)',
        expectedOutput: `Casual: (don't need to rewrite it)
Formal: All is well.`
    },
    {
        action: 'rewrite',
        input: 'I love you.',
        description: 'Universal phrase (no rewrite needed)',
        expectedOutput: `Casual: (don't need to rewrite it)
Formal: (don't need to rewrite it)`
    },
    {
        action: 'rewrite',
        input: 'Can you help me to do this?',
        description: 'Chinglish (redundant "to do")',
        expectedOutput: `Casual: Can you help me with this?
Formal: Could you assist me with this matter?

Analysis:
"Help me to do" is redundant. Use "help me with" or "help me do".`
    },
    
    // ===== EXPLAIN TESTS =====
    {
        action: 'explain',
        input: 'break the ice',
        description: 'Explain idiom (simple, no markdown)',
        expectedOutput: `"Break the ice" means to start a conversation or make people feel comfortable in a social situation.

It's commonly used when meeting new people or starting a meeting.

Example: He told a joke to break the ice at the party.`
    },
    {
        action: 'explain',
        input: 'present perfect tense',
        description: 'Explain grammar concept',
        expectedOutput: `The present perfect tense connects the past to the present. It's formed with "have/has + past participle".

Use it for:
1. Actions completed at an unspecified time (I have visited Paris)
2. Actions that started in the past and continue now (I have lived here for 5 years)
3. Recent actions with present relevance (She has just left)

Common markers: already, yet, just, ever, never, for, since`
    }
];

// Export for Node.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { testCases };
}

// Export for browser
if (typeof window !== 'undefined') {
    window.testCases = testCases;
}
