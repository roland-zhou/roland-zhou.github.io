#!/usr/bin/env node

/**
 * Test runner for lang-tools prompts
 * Usage:
 *   node test-runner.js --run              # Run tests and call API
 *   node test-runner.js --dry-run          # Show prompts without calling API
 *   node test-runner.js --compare old.json # Compare with previous results
 */

const fs = require('fs');
const path = require('path');
const testCases = require('./test-cases.js');
const { constructPrompt } = require('./prompts.js');
const { callGeminiAPI } = require('./api.js');

function getApiKey() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error('Error: GEMINI_API_KEY environment variable is not set.');
        console.error('Please set it with: export GEMINI_API_KEY="your-api-key"');
        process.exit(1);
    }
    return apiKey;
}

function filterTestCases(category) {
    if (!category) {
        return testCases;
    }

    const filtered = testCases.filter(tc => tc.category === category || tc.action === category);

    if (filtered.length === 0) {
        console.error(`\nError: No test cases found for category/action: "${category}"`);
        console.error('\nAvailable categories:');
        const categories = [...new Set(testCases.map(tc => tc.category))];
        categories.forEach(cat => {
            const count = testCases.filter(tc => tc.category === cat).length;
            console.error(`  - ${cat} (${count} tests)`);
        });
        process.exit(1);
    }

    return filtered;
}

async function runTests(dryRun = false, category = null) {
    const apiKey = dryRun ? null : getApiKey();
    const filtered = filterTestCases(category);
    const results = [];

    console.log(`\n${'='.repeat(80)}`);
    console.log(`  Running ${filtered.length} test cases (${dryRun ? 'DRY RUN' : 'LIVE'})`);
    if (category) {
        console.log(`  Filter: ${category}`);
    }
    console.log(`${'='.repeat(80)}\n`);

    for (let i = 0; i < filtered.length; i++) {
        const testCase = filtered[i];
        const prompt = constructPrompt(testCase.action, testCase.input);

        console.log(`\n[${ i + 1}/${testCases.length}] ${testCase.description}`);
        console.log(`Action: ${testCase.action}`);
        console.log(`Input: "${testCase.input}"`);

        let output = null;
        let error = null;

        if (!dryRun) {
            try {
                console.log(`\nCalling API...`);
                output = await callGeminiAPI(prompt, apiKey);
                console.log(`\n--- Output ---`);
                console.log(output);
            } catch (err) {
                error = err.message;
                console.error(`\nError: ${error}`);
            }

            // Rate limiting: wait 1 second between requests
            if (i < testCases.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        results.push({
            testCase,
            prompt,
            output,
            error,
            timestamp: new Date().toISOString()
        });

        console.log(`\n${'-'.repeat(80)}`);
    }

    return results;
}

function saveResults(results, filename) {
    const outputPath = path.join(__dirname, filename);

    let output = '';
    output += '='.repeat(80) + '\n';
    output += `Test Results - ${new Date().toISOString()}\n`;
    output += `Total: ${results.length} test cases\n`;
    output += '='.repeat(80) + '\n\n';

    results.forEach((result, index) => {
        const { testCase, output: apiOutput, error } = result;

        output += `[${index + 1}/${results.length}] ${testCase.description}\n`;
        output += `Action: ${testCase.action}\n`;
        output += `Category: ${testCase.category}\n`;
        output += `Input: "${testCase.input}"\n`;

        if (apiOutput) {
            output += `\n--- Output ---\n`;
            output += apiOutput + '\n';
            output += `\nStatus: ✓ Success\n`;
        } else if (error) {
            output += `\n--- Error ---\n`;
            output += error + '\n';
            output += `\nStatus: ✗ Failed\n`;
        } else {
            output += `\nStatus: ⊘ Skipped (dry run)\n`;
        }

        output += '\n' + '-'.repeat(80) + '\n\n';
    });

    fs.writeFileSync(outputPath, output);
    console.log(`\n✓ Results saved to: ${outputPath}`);
}

function compareResults(oldFile, category = null) {
    const oldPath = path.join(__dirname, oldFile);

    if (!fs.existsSync(oldPath)) {
        console.error(`Error: File not found: ${oldPath}`);
        process.exit(1);
    }

    // Try to parse as JSON first (old format), fallback to parsing text format
    let oldResults;
    try {
        oldResults = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
    } catch (e) {
        console.error(`Error: Unable to parse results file. Only JSON format is supported for comparison.`);
        console.error(`Hint: Run a new baseline test to generate a compatible results file.`);
        process.exit(1);
    }

    const filtered = filterTestCases(category);

    console.log(`\n${'='.repeat(80)}`);
    console.log(`  Comparing prompts with: ${oldFile}`);
    if (category) {
        console.log(`  Filter: ${category}`);
    }
    console.log(`${'='.repeat(80)}\n`);

    let changesFound = false;

    for (let i = 0; i < filtered.length; i++) {
        const testCase = filtered[i];
        const newPrompt = constructPrompt(testCase.action, testCase.input);
        const oldResult = oldResults.find(r =>
            r.testCase.action === testCase.action &&
            r.testCase.input === testCase.input
        );

        if (!oldResult) {
            console.log(`\n[NEW] ${testCase.description}`);
            console.log(`Action: ${testCase.action}`);
            console.log(`Input: "${testCase.input}"`);
            changesFound = true;
            continue;
        }

        if (newPrompt !== oldResult.prompt) {
            console.log(`\n[CHANGED] ${testCase.description}`);
            console.log(`Action: ${testCase.action}`);
            console.log(`Input: "${testCase.input}"`);
            console.log(`\n--- OLD PROMPT ---`);
            console.log(oldResult.prompt);
            console.log(`\n--- NEW PROMPT ---`);
            console.log(newPrompt);
            console.log(`\n${'-'.repeat(80)}`);
            changesFound = true;
        }
    }

    if (!changesFound) {
        console.log('✓ No prompt changes detected.');
    }
}

// Parse command line arguments
const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help') {
    console.log(`
Usage:
  node test-runner.js --run [--type <category>]           Run tests with API calls
  node test-runner.js --dry-run [--type <category>]       Show prompts without API calls
  node test-runner.js --compare <file> [--type <category>] Compare prompts with previous results
  node test-runner.js --list                               List all available test categories
  node test-runner.js --help                               Show this help message

Options:
  --type <category>    Filter tests by category or action (e.g., translate, rewrite, explain)

Environment:
  GEMINI_API_KEY      Required for --run mode

Examples:
  node test-runner.js --run --type translate
  node test-runner.js --dry-run --type rewrite
  node test-runner.js --compare test-results-old.json --type translate
`);
    process.exit(0);
}

const mode = args[0];

// Parse optional --type argument
let categoryFilter = null;
const typeIndex = args.indexOf('--type');
if (typeIndex !== -1 && args[typeIndex + 1]) {
    categoryFilter = args[typeIndex + 1];
}

(async () => {
    try {
        if (mode === '--list') {
            console.log('\nAvailable test categories:\n');
            const categories = [...new Set(testCases.map(tc => tc.category))];
            categories.forEach(cat => {
                const count = testCases.filter(tc => tc.category === cat).length;
                const actions = [...new Set(testCases.filter(tc => tc.category === cat).map(tc => tc.action))];
                console.log(`  ${cat} (${count} tests)`);
                console.log(`    Actions: ${actions.join(', ')}`);
            });
            console.log('');
        } else if (mode === '--dry-run') {
            const results = await runTests(true, categoryFilter);
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const suffix = categoryFilter ? `-${categoryFilter}` : '';
            saveResults(results, `test-results-dry${suffix}-${timestamp}.txt`);
        } else if (mode === '--run') {
            const results = await runTests(false, categoryFilter);
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const suffix = categoryFilter ? `-${categoryFilter}` : '';
            saveResults(results, `test-results${suffix}-${timestamp}.txt`);
        } else if (mode === '--compare') {
            if (args.length < 2 || args[1].startsWith('--')) {
                console.error('Error: --compare requires a filename argument');
                process.exit(1);
            }
            compareResults(args[1], categoryFilter);
        } else {
            console.error(`Error: Unknown mode "${mode}"`);
            console.error('Run with --help for usage information');
            process.exit(1);
        }
    } catch (error) {
        console.error('\nFatal error:', error);
        process.exit(1);
    }
})();
