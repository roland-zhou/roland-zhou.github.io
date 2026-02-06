#!/usr/bin/env node

/**
 * Prompt Quality Judge System
 * Tests prompts.js against multiple AI models and judges results with Claude
 * 
 * IMPORTANT: Reuses API clients from api.js to ensure test results match production behavior
 * (same temperature settings, model-specific logic, error handling, etc.)
 * 
 * Usage:
 *   ANTHROPIC_API_KEY=xxx GOOGLE_API_KEY=xxx OPENAI_API_KEY=xxx node prompts-judge.js
 */

const { constructPrompt } = require('./prompts.js');
const { testCases } = require('./prompts-test-cases.js');
const { 
    callGeminiAPI, 
    callOpenAILLM, 
    callAnthropicAPI 
} = require('./api.js');

// ===== CORE JUDGING RULES =====
const JUDGING_RULES = {
    translate: `
Core Rules for Translation Quality:

1. LANGUAGE PURITY (Critical):
   - Chinese input → Output must be 100% English (ZERO Chinese characters)
   - English input → Translation part must be 100% Chinese, IPA and usage examples must be 100% English
   - ANY mixing of source language → Output must be 100% English

2. FORMAT COMPLIANCE:
   Single Word:
   - Main translation
   - 2-3 alternatives
   - [blank line]
   - IPA (ONLY for English→Chinese)
   - [blank line]
   - 2-3 example sentences (examples for BOTH directions must be in English)
   
   Phrase (2+ words, not complete sentence):
   - Main translation
   - 2-3 alternatives
   - [blank line]
   - 2-3 example sentences (examples for BOTH directions must be in English)
   
   Complete Sentence:
   - Main translation
   - 2-3 alternative translations
   - NO examples
   - NO IPA

3. TRANSLATION QUALITY:
   - Main translation must be accurate and natural
   - Alternatives should show variety (different tones/formality/word choices)
   - Example sentences must be practical and diverse contexts

4. IPA REQUIREMENT:
   - MUST appear for English→Chinese word translations
   - MUST NOT appear for Chinese→English or sentence translations
   - Must be formatted as /.../ 

Score 0-10:
- 0-3: Failed language purity or completely wrong format
- 4-6: Correct language but missing key components or poor quality
- 7-8: Good quality with minor issues
- 9-10: Perfect execution of all rules
`,
    rewrite: `
Core Rules for English Rewriting Quality:

1. FORMAT COMPLIANCE (Critical):
   MUST follow exact format:
   Casual: [version or "(don't need to rewrite it)"]
   Formal: [version or "(don't need to rewrite it)"]
   
   Analysis: [only if there were errors]

2. "(don't need to rewrite it)" USAGE:
   - Use when input is already natural for that style
   - Use when rewritten version would be identical to input
   - DON'T use if input has grammar errors or unnatural phrasing
   - Both Casual AND Formal can be "(don't need to rewrite it)" for perfect phrases

3. REWRITING QUALITY:
   - Casual: Natural spoken English, contractions OK
   - Formal: Professional, polite, complete sentences
   - Must fix Chinglish patterns (redundant words, literal translations)
   - Must fix grammar errors

4. ANALYSIS SECTION:
   - ONLY include if there were actual errors or unnatural phrasing
   - Must explain WHAT was wrong and WHY
   - OMIT if input was already valid English

Score 0-10:
- 0-3: Wrong format or inappropriate use of "(don't need to rewrite it)"
- 4-6: Correct format but poor rewriting quality or missing Analysis
- 7-8: Good rewrites with minor issues
- 9-10: Perfect format, natural rewrites, appropriate Analysis usage
`,
    explain: `
Core Rules for Explanation Quality:

1. FORMAT (Critical):
   - NO markdown formatting (no # headers, no **, no bullets with -)
   - CAN use simple line breaks to separate points
   - Plain text only

2. EXPLANATION QUALITY:
   - Simple, clear language (target: English learners)
   - Cover meaning, usage, and examples
   - Practical context

3. STRUCTURE:
   - Start with direct definition/explanation
   - Add usage context
   - Include examples

Score 0-10:
- 0-3: Uses markdown formatting or unclear explanation
- 4-6: Clear explanation but could be simpler or more practical
- 7-8: Good explanation with minor improvements possible
- 9-10: Perfect simplicity and clarity
`
};

// ===== API CLIENTS (Reusing api.js for consistency) =====
// This ensures we test with the EXACT same parameters as production

// Note: api.js uses temperature=0 for most models (temperature=1 for o1/o3/gpt-5-mini)
// This matches the actual production behavior of the app

// ===== MODEL CONFIGURATIONS =====
// Using exact model names and api.js functions to match production behavior
const TEST_MODELS = [
    { 
        name: 'gemini-2.5-flash-lite', 
        call: (prompt, keys) => callGeminiAPI(prompt, keys.google, 'gemini-2.5-flash-lite') 
    },
    { 
        name: 'gpt-4o', 
        call: (prompt, keys) => callOpenAILLM(prompt, keys.openai, 'gpt-4o') 
    },
    { 
        name: 'gpt-4o-mini', 
        call: (prompt, keys) => callOpenAILLM(prompt, keys.openai, 'gpt-4o-mini') 
    },
    { 
        name: 'claude-3-haiku-20240307', 
        call: (prompt, keys) => callAnthropicAPI(prompt, keys.anthropic, 'claude-3-haiku-20240307') 
    }
];

const JUDGE_MODEL = {
    name: 'claude-sonnet-4-5',
    call: (prompt, keys) => callAnthropicAPI(prompt, keys.anthropic, 'claude-sonnet-4-5')
};

// ===== JUDGING LOGIC =====

async function judgeOutput(action, input, output, apiKeys) {
    const rules = JUDGING_RULES[action];
    
    const judgePrompt = `You are an expert judge evaluating AI-generated output quality.

ACTION TYPE: ${action}

JUDGING RULES:
${rules}

INPUT:
${input}

OUTPUT TO JUDGE:
${output}

Evaluate this output strictly against the rules above.

Respond in this exact format:
Score: [0-10]
Reasoning: [Brief explanation of score, cite specific rule violations or successes]
`;

    try {
        const judgeResponse = await JUDGE_MODEL.call(judgePrompt, apiKeys);
        
        // Parse score
        const scoreMatch = judgeResponse.match(/Score:\s*(\d+)/i);
        const score = scoreMatch ? parseInt(scoreMatch[1]) : 0;
        
        // Extract reasoning
        const reasoningMatch = judgeResponse.match(/Reasoning:\s*(.+)/is);
        const reasoning = reasoningMatch ? reasoningMatch[1].trim() : judgeResponse;
        
        return { score, reasoning };
    } catch (error) {
        console.error(`Judge error: ${error.message}`);
        return { score: 0, reasoning: `Judge failed: ${error.message}` };
    }
}

// ===== MAIN TEST RUNNER =====

async function runTests() {
    console.log('🧪 Prompt Quality Judge System\n');
    
    // Get API keys from environment
    const apiKeys = {
        google: process.env.GOOGLE_API_KEY,
        openai: process.env.OPENAI_API_KEY,
        anthropic: process.env.ANTHROPIC_API_KEY
    };
    
    // Validate API keys
    if (!apiKeys.anthropic) {
        console.error('❌ ANTHROPIC_API_KEY not set (required for judge model)');
        process.exit(1);
    }
    
    const results = {};
    
    for (const model of TEST_MODELS) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`📊 Testing: ${model.name}`);
        console.log('='.repeat(60));
        
        results[model.name] = {
            scores: [],
            details: []
        };
        
        for (let i = 0; i < testCases.length; i++) {
            const testCase = testCases[i];
            const testNum = i + 1;
            
            console.log(`\n[${testNum}/${testCases.length}] ${testCase.description}`);
            console.log(`Action: ${testCase.action} | Input: "${testCase.input}"`);
            
            try {
                // Generate prompt and get model output
                const fullPrompt = constructPrompt(testCase.action, testCase.input);
                const output = await model.call(fullPrompt, apiKeys);
                
                console.log(`\n📝 Output:\n${output.substring(0, 200)}${output.length > 200 ? '...' : ''}\n`);
                
                // Judge the output
                const judgment = await judgeOutput(testCase.action, testCase.input, output, apiKeys);
                
                console.log(`⚖️  Score: ${judgment.score}/10`);
                console.log(`💭 Reasoning: ${judgment.reasoning}\n`);
                
                results[model.name].scores.push(judgment.score);
                results[model.name].details.push({
                    testCase: testCase.description,
                    score: judgment.score,
                    reasoning: judgment.reasoning,
                    output: output
                });
                
            } catch (error) {
                console.error(`❌ Test failed: ${error.message}`);
                results[model.name].scores.push(0);
                results[model.name].details.push({
                    testCase: testCase.description,
                    score: 0,
                    reasoning: `Error: ${error.message}`,
                    output: null
                });
            }
            
            // Rate limiting delay
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Calculate average for this model
        const avg = results[model.name].scores.reduce((a, b) => a + b, 0) / results[model.name].scores.length;
        results[model.name].average = avg.toFixed(2);
        
        console.log(`\n✅ ${model.name} Average Score: ${results[model.name].average}/10`);
    }
    
    // ===== FINAL SUMMARY =====
    console.log('\n\n' + '='.repeat(60));
    console.log('📊 FINAL RESULTS');
    console.log('='.repeat(60));
    
    const sortedResults = Object.entries(results).sort((a, b) => b[1].average - a[1].average);
    
    for (const [modelName, data] of sortedResults) {
        console.log(`${modelName.padEnd(25)} ${data.average}/10`);
    }
    
    // Save detailed results to file
    const fs = require('fs');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = `./judge-report-${timestamp}.json`;
    
    fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
    console.log(`\n💾 Detailed report saved to: ${reportPath}`);
}

// ===== RUN =====
if (require.main === module) {
    runTests().catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}

module.exports = { judgeOutput, JUDGING_RULES };
