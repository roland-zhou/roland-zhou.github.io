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
    
    // For very short text, add padding to prevent cutoff
    // Count words (rough heuristic: split by spaces)
    const wordCount = text.trim().split(/\s+/).length;
    let paddedText = text;
    
    if (wordCount <= 3) {
        // Add a brief pause at the end for short clips
        // Using three periods with spaces creates a natural pause
        paddedText = text + ' . . .';
        console.log(`Short text detected (${wordCount} words), padded: "${paddedText}"`);
    }
    
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: 'tts-1-hd',  // Use HD model for better quality
            input: paddedText,
            voice: 'alloy',
            response_format: 'mp3'
        })
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || 'TTS request failed');
    }

    // Ensure the entire blob is downloaded
    const blob = await response.blob();
    
    // Verify blob has content
    if (blob.size === 0) {
        throw new Error('Received empty audio data');
    }
    
    console.log(`TTS audio blob size: ${blob.size} bytes`);
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
