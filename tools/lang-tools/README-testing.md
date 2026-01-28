# Lang-Tools Testing Guide

This directory contains test cases and a test runner for validating prompt changes in the lang-tools application.

## Files

- **prompts.js**: Shared prompt construction logic (used by both browser and test runner)
- **api.js**: Shared Gemini API call logic (used by both browser and test runner)
- **test-cases.js**: Defines all test cases with various input scenarios
- **test-runner.js**: Node.js script to run tests and compare results
- **script.js**: Browser application (uses shared functions from prompts.js and api.js)
- **README-testing.md**: This file

## Setup

1. Set your Gemini API key as an environment variable:
   ```bash
   export GEMINI_API_KEY="your-api-key-here"
   ```

2. Make sure you have Node.js installed (v18+ recommended for fetch support)

## Usage

### 1. List Available Test Categories

See all available test categories and their test counts:

```bash
node test-runner.js --list
```

### 2. Dry Run (No API Calls)

Preview prompts without making API calls:

```bash
# All tests
node test-runner.js --dry-run

# Only translation tests
node test-runner.js --dry-run --type translate

# Only rewrite tests
node test-runner.js --dry-run --type rewrite
```

This will show you all the generated prompts for each test case and save them to a plain text file (e.g., `test-results-dry-translate-2026-01-28T10-30-45.txt`).

### 3. Run Full Tests

Run test cases with actual API calls:

```bash
# All tests
node test-runner.js --run

# Only translation tests
node test-runner.js --run --type translate

# Only explanation tests
node test-runner.js --run --type explain
```

This will:
- Execute test cases (filtered by type if specified)
- Call the Gemini API for each one
- Display inputs, prompts, and outputs
- Save results to a timestamped plain text file (e.g., `test-results-translate-2026-01-28T10-30-45.txt`)
- Include 1 second delay between requests to respect rate limits

### 4. Compare Prompt Changes

After modifying prompts in [prompts.js](prompts.js), compare with previous results:

```bash
# Compare all tests
node test-runner.js --compare test-results-old.json

# Compare only translation tests
node test-runner.js --compare test-results-old.json --type translate
```

**Note:** Comparison currently only works with old JSON format files. For new text format files, manually compare them.

This will:
- Show which test cases have changed prompts (filtered by type if specified)
- Display old vs new prompts side-by-side
- Identify new or removed test cases

## Test Case Categories

The test suite includes:

### Translate
- English to Chinese
- Chinese to English
- Mixed language text
- Technical terms

### Rewrite
- Common Chinglish patterns
- Grammar corrections
- Casual vs formal tone
- Already-correct English

### Explain
- Idiomatic expressions
- Grammar concepts
- Word meanings
- Usage comparisons

### Edge Cases
- Emojis
- Very short input
- Internet slang

## Workflow for Prompt Changes

1. **Baseline**: Run tests and save results
   ```bash
   node test-runner.js --run
   ```

2. **Modify**: Edit prompts in [prompts.js](prompts.js)
   - This file is shared between the browser app and test runner
   - Changes automatically apply to both environments

3. **Compare**: Check what changed
   ```bash
   node test-runner.js --compare test-results-[timestamp].json
   ```

4. **Test**: Run new tests to see if outputs improved
   ```bash
   node test-runner.js --run
   ```

5. **Review**: Manually compare output quality between old and new results

## Architecture

Shared functionality is centralized in reusable modules:

### [prompts.js](prompts.js) - Prompt Construction
- Contains `constructPrompt(action, text)` function
- **Browser**: Loaded via `<script>` tag, available as `window.constructPrompt`
- **Node.js**: Imported via `require('./prompts.js')`

### [api.js](api.js) - Gemini API Calls
- Contains `callGeminiAPI(prompt, apiKey)` function
- **Browser**: Loaded via `<script>` tag, available as `window.callGeminiAPI`
- **Node.js**: Imported via `require('./api.js')`

This architecture ensures:
- Single source of truth for prompts and API logic
- Changes automatically apply to both browser and test environments
- Easy testing and validation of prompt modifications

## Adding New Test Cases

Edit [test-cases.js](test-cases.js) and add a new object to the array:

```javascript
{
  action: 'translate',  // or 'rewrite' or 'explain'
  input: 'Your test input text',
  description: 'Brief description of what this tests',
  category: 'translate'  // for organization
}
```

## Output Format

Results are saved in readable plain text format:

```
================================================================================
Test Results - 2026-01-28T10:30:45.000Z
Total: 5 test cases
================================================================================

[1/5] English to Chinese translation
Action: translate
Category: translate
Input: "Hello, how are you?"

--- Output ---
你好，最近怎么样？
Alternative 1: 你好吗？
Alternative 2: 你好，你怎么样？

Status: ✓ Success

--------------------------------------------------------------------------------

[2/5] Chinese to English translation
...
```

## Tips

- Use `--dry-run` first to verify test cases before spending API credits
- Save baseline results before making prompt changes
- Compare outputs manually to assess quality improvements
- Add new test cases when you discover edge cases
- Keep old result files for reference (they're gitignored)

## Troubleshooting

**"GEMINI_API_KEY environment variable is not set"**
- Run: `export GEMINI_API_KEY="your-key"`
- Or add to your `~/.bashrc` or `~/.zshrc`

**API rate limiting errors**
- The script includes 1-second delays between requests
- If you still hit limits, you can increase the delay in test-runner.js

**"fetch is not defined"**
- You need Node.js v18+ which includes native fetch
- Or install node-fetch: `npm install node-fetch`
