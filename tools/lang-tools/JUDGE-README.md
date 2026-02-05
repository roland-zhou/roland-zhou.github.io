# Prompt Quality Judge System

A comprehensive testing framework for evaluating `prompts.js` quality across multiple AI models.

## Overview

This system:
1. **Defines core rules** (learned from existing prompts) in `prompts-judge.js`
2. **Maintains test cases** with input/output pairs in `prompts-test-cases.js`
3. **Tests prompts** against multiple AI models (Gemini, GPT, Claude)
4. **Judges outputs** using a stable pro model (Gemini 3 Pro)
5. **Reports scores** with detailed reasoning

## Files

- **`prompts-judge.js`** - Main judge system and test runner
- **`prompts-test-cases.js`** - Test cases (input + expected output samples)
- **Core rules** - Embedded in `prompts-judge.js`, derived from `prompts.js`

## Setup

### 1. Install Dependencies

```bash
cd tools/lang-tools
npm install node-fetch  # if not already installed
```

### 2. Set API Keys

Export your API keys as environment variables:

```bash
export GOOGLE_API_KEY="your-google-api-key"
export OPENAI_API_KEY="your-openai-api-key"
export ANTHROPIC_API_KEY="your-anthropic-api-key"
```

Or create a `.env` file:

```
GOOGLE_API_KEY=your-google-api-key
OPENAI_API_KEY=your-openai-api-key
ANTHROPIC_API_KEY=your-anthropic-api-key
```

## Usage

### Run Full Test Suite

```bash
node prompts-judge.js
```

This will:
1. Test each case against all configured models:
   - `gemini-2.0-flash-exp`
   - `gemini-2.5-flash-lite`
   - `gpt-4o`
   - `gpt-4o-mini`
   - `claude-3-5-sonnet-20241022`

2. Judge each output using `gemini-exp-1206` (Gemini Pro)

**Note:** Uses API clients from `api.js` to ensure production-identical parameters (temperature=0 for most models)

3. Calculate average scores per model

4. Save detailed report to `judge-report-[timestamp].json`

### Test Specific Models

Edit `TEST_MODELS` array in `prompts-judge.js` to enable/disable models:

```javascript
const TEST_MODELS = [
    { name: 'gemini-2.0-flash-exp', call: (prompt, keys) => callGeminiAPI(prompt, keys.google, 'gemini-2.0-flash-exp') },
    // Comment out models you don't want to test
];
```

## Core Judging Rules

### Translation Rules
1. **Language Purity** (Critical) - No mixing source/target languages
2. **Format Compliance** - Different formats for word/phrase/sentence
3. **Translation Quality** - Accuracy, alternatives, practical examples
4. **IPA Requirement** - Only for English→Chinese words

### Rewrite Rules
1. **Format Compliance** - Exact `Casual:/Formal:/Analysis:` structure
2. **"(don't need to rewrite it)" Usage** - Only when input is already natural
3. **Rewriting Quality** - Fix Chinglish and grammar errors
4. **Analysis Section** - Only include if there were actual errors

### Explain Rules
1. **Format** - No markdown, plain text, simple line breaks OK
2. **Explanation Quality** - Simple language for learners
3. **Structure** - Definition → Usage → Examples

## Adding Test Cases

Edit `prompts-test-cases.js`:

```javascript
{
    action: 'translate',
    input: '你好',
    description: 'Chinese greeting → English',
    expectedOutput: `Hello
Hi
Greetings

Hello, how are you?
Hi there!
Greetings, everyone.`
}
```

## Output Format

### Console Output

```
🧪 Prompt Quality Judge System

============================================================
📊 Testing: gemini-3-flash
============================================================

[1/10] Chinese word → English
Action: translate | Input: "弹窗"

📝 Output:
Pop-up window
Pop-up
...

⚖️  Score: 9/10
💭 Reasoning: Excellent language purity, proper format...

...

✅ gemini-3-flash Average Score: 8.50/10
```

### JSON Report

Saved as `judge-report-[timestamp].json`:

```json
{
  "gemini-3-flash": {
    "scores": [9, 8, 10, 7, ...],
    "average": "8.50",
    "details": [
      {
        "testCase": "Chinese word → English",
        "score": 9,
        "reasoning": "...",
        "output": "..."
      }
    ]
  }
}
```

## Scoring System

- **0-3**: Failed critical rules (language purity, format)
- **4-6**: Correct basics but missing quality
- **7-8**: Good quality with minor issues
- **9-10**: Perfect execution

## Maintenance

### Updating Core Rules

Edit `JUDGING_RULES` in `prompts-judge.js` when prompts evolve:

```javascript
const JUDGING_RULES = {
    translate: `
Core Rules for Translation Quality:
...
`,
    // Add new rules as prompts.js evolves
}
```

### Changing Judge Model

Edit `JUDGE_MODEL` in `prompts-judge.js`:

```javascript
const JUDGE_MODEL = {
    name: 'gpt-4o',
    call: (prompt, keys) => callOpenAILLM(prompt, keys.openai, 'gpt-4o')
};
```

## Tips

1. **Rate Limiting**: Script includes 1-second delays between API calls
2. **Cost Management**: Each test run costs ~$0.10-0.50 depending on models
3. **Incremental Testing**: Comment out models/test cases for quick iterations
4. **Error Handling**: Failed API calls score 0 but don't stop the entire run

## Example Workflow

```bash
# 1. Add new test case
echo "Edit prompts-test-cases.js"

# 2. Update prompt in prompts.js
echo "Edit prompts.js"

# 3. Run judge
GOOGLE_API_KEY=xxx node prompts-judge.js

# 4. Review results
cat judge-report-*.json

# 5. Iterate on prompt based on feedback
```
