/**
 * Test cases for lang-tools prompts
 * Each test case has an action, input text, and description
 */

const testCases = [
  // Translate action tests
  {
    action: 'translate',
    input: 'Hello, how are you?',
    description: 'English to Chinese translation',
    category: 'translate'
  },
  {
    action: 'translate',
    input: '你好，最近怎么样？',
    description: 'Chinese to English translation',
    category: 'translate'
  },
  {
    action: 'translate',
    input: 'I went to the store yesterday 因为需要买一些东西。',
    description: 'Mixed English-Chinese to English translation',
    category: 'translate'
  },
  {
    action: 'translate',
    input: 'The quick brown fox jumps over the lazy dog.',
    description: 'Complex English sentence to Chinese',
    category: 'translate'
  },
  {
    action: 'translate',
    input: '机器学习是人工智能的一个重要分支。',
    description: 'Technical Chinese term to English',
    category: 'translate'
  },
  {
    action: 'translate',
    input: 'Were you a cross-border commuter at anytime between 01-Jan-2025 and 31-Dec-2025?',
    description: 'Complex English to Chinese translation with legal context',
    category: 'translate'
  },

  // Rewrite action tests
  {
    action: 'rewrite',
    input: 'I very like this movie.',
    description: 'Simple Chinglish grammar fix',
    category: 'rewrite'
  },
  {
    action: 'rewrite',
    input: 'Can you help me to do this thing?',
    description: 'Chinglish expression to natural English',
    category: 'rewrite'
  },
  {
    action: 'rewrite',
    input: 'Good work!',
    description: 'Already good casual English (should keep casual version)',
    category: 'rewrite'
  },
  {
    action: 'rewrite',
    input: 'Please to help me understand this question.',
    description: 'Chinglish with extra "to"',
    category: 'rewrite'
  },
  {
    action: 'rewrite',
    input: 'I am very pleasure to meet you.',
    description: 'Chinglish adjective usage',
    category: 'rewrite'
  },
  {
    action: 'rewrite',
    input: 'The meeting will be hold tomorrow.',
    description: 'Chinglish verb form',
    category: 'rewrite'
  },

  // Explain action tests
  {
    action: 'explain',
    input: 'break the ice',
    description: 'Idiomatic expression explanation',
    category: 'explain'
  },
  {
    action: 'explain',
    input: 'present perfect tense',
    description: 'Grammar concept explanation',
    category: 'explain'
  },
  {
    action: 'explain',
    input: 'serendipity',
    description: 'Single word explanation',
    category: 'explain'
  },
  {
    action: 'explain',
    input: 'Could you please vs Can you please',
    description: 'Usage comparison explanation',
    category: 'explain'
  },
  {
    action: 'explain',
    input: 'She has been working here for five years.',
    description: 'Sentence structure and grammar explanation',
    category: 'explain'
  },

  // Edge cases
  {
    action: 'translate',
    input: '😊👍',
    description: 'Emoji translation',
    category: 'edge-cases'
  },
  {
    action: 'rewrite',
    input: 'a',
    description: 'Single character rewrite',
    category: 'edge-cases'
  },
  {
    action: 'explain',
    input: 'LOL ROFL LMAO',
    description: 'Internet slang explanation',
    category: 'edge-cases'
  }
];

module.exports = testCases;
