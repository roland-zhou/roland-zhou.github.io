#!/usr/bin/env node

/**
 * LLM Prompt Test Runner
 *
 * Usage:
 *   GEMINI_API_KEY=your_key node tools/lang-tools/test-prompts.js
 *
 * Options:
 *   --action=translate|rewrite|explain  Run only specific action tests
 *   --verbose                           Show full LLM responses
 */

const { PROMPTS } = require('./prompts.js');
const testCases = require('./test-cases.json');

const API_KEY = process.env.GEMINI_API_KEY;
const API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent';

// Parse command line arguments
const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const actionArg = args.find(a => a.startsWith('--action='));
const filterAction = actionArg ? actionArg.split('=')[1] : null;

// Colors for terminal output
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    dim: '\x1b[2m'
};

async function callGeminiAPI(prompt) {
    const url = `${API_URL}?key=${API_KEY}&fields=candidates.content.parts.text`;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            contents: [{
                parts: [{
                    text: prompt
                }]
            }]
        })
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || 'API request failed');
    }

    const data = await response.json();
    if (data.candidates && data.candidates.length > 0 && data.candidates[0].content) {
        return data.candidates[0].content.parts[0].text;
    } else {
        throw new Error('No content generated');
    }
}

function checkPatterns(output, patterns) {
    const lowerOutput = output.toLowerCase();
    const results = patterns.map(pattern => ({
        pattern,
        found: lowerOutput.includes(pattern.toLowerCase())
    }));
    return results;
}

async function runTest(action, testCase) {
    const prompt = PROMPTS[action](testCase.input);

    try {
        const output = await callGeminiAPI(prompt);
        const patternResults = checkPatterns(output, testCase.expectedPatterns);
        const allPassed = patternResults.every(r => r.found);

        return {
            success: true,
            passed: allPassed,
            output,
            patternResults
        };
    } catch (error) {
        return {
            success: false,
            passed: false,
            error: error.message
        };
    }
}

async function runAllTests() {
    if (!API_KEY) {
        console.error(`${colors.red}Error: GEMINI_API_KEY environment variable is required${colors.reset}`);
        console.error('Usage: GEMINI_API_KEY=your_key node test-prompts.js');
        process.exit(1);
    }

    console.log(`${colors.cyan}=== LLM Prompt Test Runner ===${colors.reset}\n`);

    const actions = filterAction ? [filterAction] : Object.keys(testCases);
    let totalTests = 0;
    let passedTests = 0;
    let failedTests = 0;

    for (const action of actions) {
        if (!testCases[action]) {
            console.error(`${colors.red}Unknown action: ${action}${colors.reset}`);
            continue;
        }

        console.log(`${colors.cyan}Testing: ${action}${colors.reset}`);
        console.log('-'.repeat(40));

        for (const testCase of testCases[action]) {
            totalTests++;
            process.stdout.write(`  ${testCase.description}... `);

            const result = await runTest(action, testCase);

            if (!result.success) {
                failedTests++;
                console.log(`${colors.red}ERROR${colors.reset}`);
                console.log(`    ${colors.dim}Error: ${result.error}${colors.reset}`);
            } else if (result.passed) {
                passedTests++;
                console.log(`${colors.green}PASS${colors.reset}`);
            } else {
                failedTests++;
                console.log(`${colors.red}FAIL${colors.reset}`);
                const missing = result.patternResults
                    .filter(r => !r.found)
                    .map(r => r.pattern);
                console.log(`    ${colors.dim}Missing patterns: ${missing.join(', ')}${colors.reset}`);
            }

            if (verbose && result.output) {
                console.log(`    ${colors.dim}Input: ${testCase.input}${colors.reset}`);
                console.log(`    ${colors.dim}Output: ${result.output.substring(0, 200)}...${colors.reset}`);
            }

            // Rate limiting: wait 1 second between API calls
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        console.log();
    }

    // Summary
    console.log('='.repeat(40));
    console.log(`${colors.cyan}Summary:${colors.reset}`);
    console.log(`  Total:  ${totalTests}`);
    console.log(`  ${colors.green}Passed: ${passedTests}${colors.reset}`);
    console.log(`  ${colors.red}Failed: ${failedTests}${colors.reset}`);

    // Exit with error code if any tests failed
    process.exit(failedTests > 0 ? 1 : 0);
}

// Run tests
runAllTests();
