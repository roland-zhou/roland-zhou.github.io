/**
 * Shared API logic for lang-tools
 * This module works in both Node.js and browser environments
 */

async function callGeminiAPI(prompt, apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}&fields=candidates.content.parts.text`;

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
            }],
            generationConfig: {
                temperature: 0
            }
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

async function callOpenAITTS(text, apiKey) {
    const url = 'https://api.openai.com/v1/audio/speech';
    
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: 'tts-1',
            input: text,
            voice: 'alloy'
        })
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || 'TTS request failed');
    }

    const blob = await response.blob();
    return URL.createObjectURL(blob);
}

// Export for Node.js (CommonJS)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { callGeminiAPI, callOpenAITTS };
}

// Export for browser (global)
if (typeof window !== 'undefined') {
    window.callGeminiAPI = callGeminiAPI;
    window.callOpenAITTS = callOpenAITTS;
}
