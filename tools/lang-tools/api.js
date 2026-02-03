/**
 * Shared API logic for lang-tools
 * This module works in both Node.js and browser environments
 */

// Main LLM router
async function callLLM(provider, prompt, apiKey, model) {
    switch (provider) {
        case 'gemini':
            return await callGeminiAPI(prompt, apiKey, model);
        case 'openai':
            return await callOpenAILLM(prompt, apiKey, model);
        case 'anthropic':
            return await callAnthropicAPI(prompt, apiKey, model);
        default:
            throw new Error(`Unknown LLM provider: ${provider}`);
    }
}

// Main TTS router
async function callTTS(provider, text, apiKey, model, voice) {
    switch (provider) {
        case 'openai':
            return await callOpenAITTS(text, apiKey, model, voice);
        case 'elevenlabs':
            return await callElevenLabsTTS(text, apiKey, model);
        default:
            throw new Error(`Unknown TTS provider: ${provider}`);
    }
}

async function callGeminiAPI(prompt, apiKey, model = 'gemini-2.5-flash-latest') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}&fields=candidates.content.parts.text`;

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

async function callOpenAILLM(prompt, apiKey, model = 'gpt-4o') {
    const url = 'https://api.openai.com/v1/chat/completions';
    
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: model,
            messages: [{
                role: 'user',
                content: prompt
            }],
            temperature: 0
        })
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || 'OpenAI request failed');
    }

    const data = await response.json();
    if (data.choices && data.choices.length > 0) {
        return data.choices[0].message.content;
    } else {
        throw new Error('No content generated');
    }
}

async function callAnthropicAPI(prompt, apiKey, model = 'claude-3-5-sonnet-20241022') {
    const url = 'https://api.anthropic.com/v1/messages';
    
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: model,
            messages: [{
                role: 'user',
                content: prompt
            }],
            max_tokens: 4096,
            temperature: 0
        })
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || 'Anthropic request failed');
    }

    const data = await response.json();
    if (data.content && data.content.length > 0) {
        return data.content[0].text;
    } else {
        throw new Error('No content generated');
    }
}

async function callOpenAITTS(text, apiKey, model = 'tts-1-hd', voice = 'alloy') {
    const url = 'https://api.openai.com/v1/audio/speech';
    
    // For very short text, add padding to prevent cutoff
    // Count words (rough heuristic: split by spaces)
    const wordCount = text.trim().split(/\s+/).length;
    let paddedText = text;
    
    if (wordCount === 1) {
        // Single word: repeat 2x to ensure complete playback
        paddedText = `${text}. ${text}.`;
        console.log(`Single word detected, repeating 2x for complete playback`);
    }
    // Multiple words (2+): no padding needed
    
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: model,
            input: paddedText,
            voice: voice,
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

async function callElevenLabsTTS(text, apiKey, model = 'eleven_turbo_v2_5') {
    // Get available voices first
    const voicesUrl = 'https://api.elevenlabs.io/v1/voices';
    const voicesResponse = await fetch(voicesUrl, {
        headers: {
            'xi-api-key': apiKey
        }
    });
    
    if (!voicesResponse.ok) {
        throw new Error('Failed to fetch voices');
    }
    
    const voicesData = await voicesResponse.json();
    // Use first available voice, or default to a known voice ID
    const voiceId = voicesData.voices?.[0]?.voice_id || '21m00Tcm4TlvDq8ikWAM';
    
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
    
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            text: text,
            model_id: model,
            voice_settings: {
                stability: 0.5,
                similarity_boost: 0.5
            }
        })
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail?.message || 'ElevenLabs TTS request failed');
    }

    const blob = await response.blob();
    
    if (blob.size === 0) {
        throw new Error('Received empty audio data');
    }
    
    console.log(`ElevenLabs TTS audio blob size: ${blob.size} bytes`);
    return URL.createObjectURL(blob);
}

// Export for Node.js (CommonJS)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { 
        callLLM, 
        callTTS,
        callGeminiAPI, 
        callOpenAILLM,
        callAnthropicAPI,
        callOpenAITTS,
        callElevenLabsTTS
    };
}

// Export for browser (global)
if (typeof window !== 'undefined') {
    window.callLLM = callLLM;
    window.callTTS = callTTS;
    window.callGeminiAPI = callGeminiAPI;
    window.callOpenAILLM = callOpenAILLM;
    window.callAnthropicAPI = callAnthropicAPI;
    window.callOpenAITTS = callOpenAITTS;
    window.callElevenLabsTTS = callElevenLabsTTS;
}
