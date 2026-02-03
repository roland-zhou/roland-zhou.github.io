// Global Error Handler - DEBUG MODE
window.onerror = function(message, source, lineno, colno, error) {
    console.error("Global Error:", message, error);
    alert("System Error: " + message + "\nAt: " + lineno + ":" + colno);
};

// DOM Elements
const inputText = document.getElementById('input-text');
const cleanBtn = document.getElementById('clean-btn');
const actionBtns = document.querySelectorAll('.action-btn[data-action]');
const outputContainer = document.getElementById('output-container');
const outputContent = document.getElementById('output-content');
const loadingIndicator = document.getElementById('loading-indicator');
const emptyState = document.getElementById('empty-state');
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const closeModalBtn = document.getElementById('close-modal');
const saveSettingsBtn = document.getElementById('save-settings');
const cancelSettingsBtn = document.getElementById('cancel-settings');
const inputSpeakerBtn = document.getElementById('input-speaker-btn');
const outputSpeakerBtn = document.getElementById('output-speaker-btn');
const ankiBtn = document.getElementById('anki-btn');

// Settings State
let settings = {
    llm: {
        provider: 'gemini',
        gemini: { apiKey: '', model: 'gemini-3-pro-preview' },
        openai: { apiKey: '', model: 'gpt-4o' },
        anthropic: { apiKey: '', model: 'claude-sonnet-4-5' },
        kimi: { apiKey: '', model: 'moonshot-v1-8k' }
    },
    tts: {
        provider: 'openai',
        openai: { apiKey: '', model: 'tts-1-hd', voice: 'alloy' },
        elevenlabs: { apiKey: '', model: 'eleven_turbo_v2_5' }
    }
};
let lastAction = 'other';

// Initialize
function init() {
    try {
        // Load settings from localStorage
        loadSettings();
        
        // Initialize SQL.js for Android APKG generation
        const config = {
            locateFile: filename => `libs/sql-wasm.wasm`
        };
        
        // Check if library loaded (it might be deferred)
        if (window.initSqlJs) {
            window.initSqlJs(config).then(function (sql) {
                window.SQL = sql;
                console.log("SQL.js initialized");
            }).catch(err => console.error("SQL.js failed to load", err));
        } else {
            console.log("SQL.js not yet loaded (deferred)");
        }
    } catch (e) {
        alert("Init Error: " + e.message);
    }
}

function loadSettings() {
    // Check for old settings format and migrate
    const oldGeminiKey = localStorage.getItem('gemini_api_key');
    const oldOpenAiKey = localStorage.getItem('openai_api_key');
    
    if (oldGeminiKey || oldOpenAiKey) {
        // Migrate old settings
        if (oldGeminiKey) {
            settings.llm.gemini.apiKey = oldGeminiKey;
        }
        if (oldOpenAiKey) {
            settings.tts.openai.apiKey = oldOpenAiKey;
        }
        // Save migrated settings
        localStorage.setItem('lang_tools_settings', JSON.stringify(settings));
        // Clean up old keys
        localStorage.removeItem('gemini_api_key');
        localStorage.removeItem('openai_api_key');
        console.log('Migrated old settings to new format');
    }
    
    // Load from localStorage or use defaults
    const saved = localStorage.getItem('lang_tools_settings');
    if (saved) {
        try {
            const loaded = JSON.parse(saved);
            // Merge with defaults to ensure all fields exist
            settings = {
                llm: { ...settings.llm, ...loaded.llm },
                tts: { ...settings.tts, ...loaded.tts }
            };
        } catch (e) {
            console.error('Failed to parse settings:', e);
        }
    }
    
    // Populate the form
    populateSettingsForm();
}

function populateSettingsForm() {
    // LLM Provider
    const llmProvider = settings.llm.provider;
    const llmRadio = document.getElementById(`llm-${llmProvider}`);
    if (llmRadio) llmRadio.checked = true;
    
    // LLM Keys and Models
    document.getElementById('gemini-api-key').value = settings.llm.gemini.apiKey;
    document.getElementById('gemini-model').value = settings.llm.gemini.model;
    document.getElementById('openai-llm-api-key').value = settings.llm.openai.apiKey;
    document.getElementById('openai-llm-model').value = settings.llm.openai.model;
    document.getElementById('anthropic-api-key').value = settings.llm.anthropic.apiKey;
    document.getElementById('anthropic-model').value = settings.llm.anthropic.model;
    document.getElementById('kimi-api-key').value = settings.llm.kimi?.apiKey || '';
    document.getElementById('kimi-model').value = settings.llm.kimi?.model || 'moonshot-v1-8k';
    
    // Show/hide LLM configs
    document.querySelectorAll('[id^="config-llm-"]').forEach(config => {
        config.style.display = 'none';
    });
    const selectedLlmConfig = document.getElementById(`config-llm-${llmProvider}`);
    if (selectedLlmConfig) selectedLlmConfig.style.display = 'flex';
    
    // TTS Provider
    const ttsProvider = settings.tts.provider;
    const ttsRadio = document.getElementById(`tts-${ttsProvider}`);
    if (ttsRadio) ttsRadio.checked = true;
    
    // TTS Keys and Models
    document.getElementById('openai-tts-api-key').value = settings.tts.openai.apiKey;
    document.getElementById('openai-tts-model').value = settings.tts.openai.model;
    document.getElementById('openai-tts-voice').value = settings.tts.openai.voice;
    document.getElementById('elevenlabs-api-key').value = settings.tts.elevenlabs.apiKey;
    document.getElementById('elevenlabs-model').value = settings.tts.elevenlabs.model;
    
    // Show/hide TTS configs
    document.querySelectorAll('[id^="config-tts-"]').forEach(config => {
        config.style.display = 'none';
    });
    const selectedTtsConfig = document.getElementById(`config-tts-${ttsProvider}`);
    if (selectedTtsConfig) selectedTtsConfig.style.display = 'flex';
}

// Event Listeners
if (inputSpeakerBtn) {
    inputSpeakerBtn.addEventListener('click', () => {
        handleSpeak(inputText.value.trim(), inputSpeakerBtn);
    });
}

if (outputSpeakerBtn) {
    outputSpeakerBtn.addEventListener('click', () => {
        handleSpeak(outputContent.value.trim(), outputSpeakerBtn);
    });
}

if (actionBtns.length > 0) {
    actionBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            // Find closest button in case user clicked icon span
            const btnElement = e.target.closest('.action-btn[data-action]');
            if (btnElement && btnElement.dataset.action) {
                handleAction(btnElement.dataset.action);
                lastAction = btnElement.dataset.action;
            }
        });
    });
} else {
    alert("Warning: No action buttons found in DOM");
}

if (settingsBtn) {
    settingsBtn.addEventListener('click', openModal);
}

if (closeModalBtn) closeModalBtn.addEventListener('click', closeModal);
if (cancelSettingsBtn) cancelSettingsBtn.addEventListener('click', closeModal);
if (saveSettingsBtn) saveSettingsBtn.addEventListener('click', saveSettings);

// Provider radio button handlers
const llmRadios = document.querySelectorAll('input[name="llm-provider"]');
const ttsRadios = document.querySelectorAll('input[name="tts-provider"]');

llmRadios.forEach(radio => {
    radio.addEventListener('change', () => {
        document.querySelectorAll('[id^="config-llm-"]').forEach(config => {
            config.style.display = 'none';
        });
        const selectedConfig = document.getElementById(`config-llm-${radio.value}`);
        if (selectedConfig) selectedConfig.style.display = 'flex';
    });
});

    ttsRadios.forEach(radio => {
    radio.addEventListener('change', () => {
        document.querySelectorAll('[id^="config-tts-"]').forEach(config => {
            config.style.display = 'none';
        });
        const selectedConfig = document.getElementById(`config-tts-${radio.value}`);
        if (selectedConfig) selectedConfig.style.display = 'flex';
    });
});


if (cleanBtn) {
    cleanBtn.addEventListener('click', () => {
        if (inputText) inputText.value = '';
        if (outputContent) outputContent.value = '';
        if (outputContainer) outputContainer.style.display = 'none';
        if (emptyState) emptyState.style.display = 'flex';
        if (inputText) inputText.focus();
    });
}

// Auto-resize listeners
if (inputText) {
    inputText.addEventListener('input', () => autoResize(inputText));
    inputText.addEventListener('change', () => autoResize(inputText));
    // Initial resize if needed (e.g. on reload with content)
    window.addEventListener('load', () => autoResize(inputText));
    // Also resize on paste
    inputText.addEventListener('paste', () => {
        setTimeout(() => autoResize(inputText), 0);
    });
}

if (outputContent) {
    outputContent.addEventListener('input', () => autoResize(outputContent));
    outputContent.addEventListener('change', () => autoResize(outputContent));
    outputContent.addEventListener('paste', () => {
        setTimeout(() => autoResize(outputContent), 0);
    });
}

if (ankiBtn) {
    ankiBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
            const isMobile = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(navigator.userAgent.toLowerCase());
            const isAndroid = /android/i.test(navigator.userAgent.toLowerCase());
            const front = inputText ? inputText.value.trim().replace(/\n/g, '<br>') : "";
            const back = outputContent ? outputContent.value.trim().replace(/\n/g, '<br>') : "";

            if (!front && !back) {
                 alert("Nothing to add.");
                 return;
            }

            if (isAndroid) {
                // Android: Generate .apkg file
                // Try to load SQL if not ready
                if (!window.SQL && window.initSqlJs) {
                     const config = { locateFile: filename => `libs/sql-wasm.wasm` };
                     window.SQL = await window.initSqlJs(config);
                }

                if (!window.SQL) {
                    alert("Anki generator is still loading or failed. Please wait a few seconds and try again.");
                    return;
                }
                
                ankiBtn.disabled = true;
                ankiBtn.innerText = "Generating...";
                // Small delay to let UI update
                await new Promise(r => setTimeout(r, 10));
                
                // Check if GenAnki classes are loaded
                if (typeof Model === 'undefined' || typeof Package === 'undefined') {
                    // Try to debug: what is available?
                    console.log("Model undefined. Window keys starting with M:", Object.keys(window).filter(k => k.startsWith('M')));
                    throw new Error("GenAnki library (Model/Package) not loaded. Please wait or refresh.");
                }

                // Define Basic Model
                const m = new Model({
                  name: "Basic",
                  id: "1", // Use simple ID
                  flds: [
                    { name: "Front" },
                    { name: "Back" }
                  ],
                  req: [
                    [ 0, "all", [ 0 ] ]
                  ],
                  tmpls: [
                    {
                      name: "Card 1",
                      qfmt: "{{Front}}",
                      afmt: "{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}",
                    }
                  ],
                });

                // Create Deck - Use ID 1 (Default) to ensure it merges correctly
                const d = new Deck(1, "Default");
                const tags = lastAction ? [lastAction] : [];
                d.addNote(m.note([front, back], tags));

                const p = new Package();
                p.addDeck(d);
                
                // Write to file (FileSaver)
                p.writeToFile(`anki_card_${Date.now()}.apkg`);

                ankiBtn.innerText = "Create Anki Card";
                ankiBtn.disabled = false;
            } else if (isMobile) {
                const url = `anki://x-callback-url/addnote?type=Basic&deck=Default&fldFront=${encodeURIComponent(front)}&fldBack=${encodeURIComponent(back)}&tags=${encodeURIComponent(lastAction)}`;
                window.location.href = url;
            } else {
                const payload = {
                    action: "addNote",
                    version: 6,
                    params: {
                        note: {
                            deckName: "Default",
                            modelName: "Basic",
                            fields: {
                                Front: front,
                                Back: back
                            },
                            options: {
                                allowDuplicate: false,
                                duplicateScope: "deck"
                            },
                            tags: [lastAction]
                        }
                    }
                };
        
                fetch('http://127.0.0.1:8765', {
                    method: 'POST',
                    body: JSON.stringify(payload)
                })
                .then(response => response.json())
                .then(result => {
                    if (result.error) {
                        alert('Anki Error: ' + result.error);
                    } else {
                        alert('Card added to Anki!');
                    }
                })
                .catch(error => {
                    console.error('Error calling Anki-Connect:', error);
                    alert('Failed to connect to Anki. Make sure Anki is running with Anki-Connect installed.');
                });
            }
        } catch (err) {
            console.error(err);
            alert("Anki Error: " + err.message);
            ankiBtn.innerText = "Create Anki Card";
            ankiBtn.disabled = false;
        }
    });
}

// Close Anki modal when clicking outside
window.addEventListener('click', (e) => {
    if (settingsModal && e.target === settingsModal) {
        closeModal();
    }
});

// Functions
function openModal() {
    if (!settingsModal) return;
    populateSettingsForm(); // Refresh form with current settings
    settingsModal.classList.add('show');
}

function closeModal() {
    if (settingsModal) settingsModal.classList.remove('show');
}

function saveSettings() {
    try {
        // Get selected providers
        settings.llm.provider = document.querySelector('input[name="llm-provider"]:checked')?.value || 'gemini';
        settings.tts.provider = document.querySelector('input[name="tts-provider"]:checked')?.value || 'openai';
        
        // Save LLM settings
        settings.llm.gemini.apiKey = document.getElementById('gemini-api-key')?.value.trim() || '';
        settings.llm.gemini.model = document.getElementById('gemini-model')?.value || 'gemini-2.5-flash-latest';
        settings.llm.openai.apiKey = document.getElementById('openai-llm-api-key')?.value.trim() || '';
        settings.llm.openai.model = document.getElementById('openai-llm-model')?.value || 'gpt-4o';
        settings.llm.anthropic.apiKey = document.getElementById('anthropic-api-key')?.value.trim() || '';
        settings.llm.anthropic.model = document.getElementById('anthropic-model')?.value || 'claude-sonnet-4-5';
        
        // Save Kimi settings (ensure object exists if migrating)
        if (!settings.llm.kimi) settings.llm.kimi = {};
        settings.llm.kimi.apiKey = document.getElementById('kimi-api-key')?.value.trim() || '';
        settings.llm.kimi.model = document.getElementById('kimi-model')?.value || 'moonshot-v1-8k';
        
        // Save TTS settings
        settings.tts.openai.apiKey = document.getElementById('openai-tts-api-key')?.value.trim() || '';
        settings.tts.openai.model = document.getElementById('openai-tts-model')?.value || 'tts-1-hd';
        settings.tts.openai.voice = document.getElementById('openai-tts-voice')?.value || 'alloy';
        settings.tts.elevenlabs.apiKey = document.getElementById('elevenlabs-api-key')?.value.trim() || '';
        settings.tts.elevenlabs.model = document.getElementById('elevenlabs-model')?.value || 'eleven_turbo_v2_5';
        
        // Save to localStorage
        localStorage.setItem('lang_tools_settings', JSON.stringify(settings));
        
        closeModal();
        alert('Settings saved successfully!');
    } catch (e) {
        console.error('Error saving settings:', e);
        alert('Error saving settings: ' + e.message);
    }
}

async function handleAction(action) {
    try {
        if (!inputText) return;
        const text = inputText.value.trim();
        if (!text) {
            alert('Please enter some text first.');
            return;
        }

        const provider = settings.llm.provider;
        const apiKey = settings.llm[provider].apiKey;
        
        if (!apiKey) {
            openModal();
            alert(`Please save your ${provider.toUpperCase()} API Key first.`);
            return;
        }

        showLoading();

        // Assuming constructPrompt is global from prompts.js
        if (typeof constructPrompt === 'undefined') {
            throw new Error("Helper scripts not loaded. Please refresh.");
        }
        
        const prompt = constructPrompt(action, text);
        const model = settings.llm[provider].model;
        const result = await callLLM(provider, prompt, apiKey, model);
        showResult(result);
    } catch (error) {
        console.error('Error:', error);
        alert(`Error: ${error.message || 'Unknown error'}`);
        // Reset loading state if error
        if (loadingIndicator) loadingIndicator.style.display = 'none';
        if (emptyState && !outputContent.value) emptyState.style.display = 'flex';
        actionBtns.forEach(btn => btn.disabled = false);
    }
}


function showLoading() {
    if (emptyState) emptyState.style.display = 'none';
    if (outputContainer) outputContainer.style.display = 'flex';
    // For editable textarea, we clear value and show overlapping loader
    if (outputContent) outputContent.value = '';
    if (loadingIndicator) loadingIndicator.style.display = 'flex';

    // Disable buttons
    actionBtns.forEach(btn => btn.disabled = true);
}

function showResult(text) {
    if (loadingIndicator) loadingIndicator.style.display = 'none';
    if (outputContent) {
        outputContent.value = text;
        // Use setTimeout to ensure DOM has updated before resize
        setTimeout(() => autoResize(outputContent), 0);
    }

    // Enable buttons
    actionBtns.forEach(btn => btn.disabled = false);
}

// Store current playing audio to prevent garbage collection
let currentAudio = null;

async function handleSpeak(text, btn) {
    if (!text) {
        alert('Nothing to read.');
        return;
    }
    
    const provider = settings.tts.provider;
    const apiKey = settings.tts[provider].apiKey;
    
    if (!apiKey) {
        openModal();
        alert(`Please save your ${provider.toUpperCase()} API Key first for TTS.`);
        return;
    }
    
    // Stop and cleanup any currently playing audio
    if (currentAudio) {
        try {
            currentAudio.pause();
            currentAudio.src = '';
            currentAudio.load();
        } catch (e) {
            console.log('Error cleaning up previous audio:', e);
        }
        currentAudio = null;
    }
    
    const originalIcon = btn.innerHTML;
    // Show loading spinner
    btn.innerHTML = '<div class="spinner" style="width:14px;height:14px;border-width:2px;"></div>';
    btn.disabled = true;
    
    let audioUrl = null;
    
    try {
        const model = settings.tts[provider].model;
        const voice = settings.tts[provider].voice; // Only for OpenAI
        audioUrl = await callTTS(provider, text, apiKey, model, voice);
        currentAudio = new Audio();
        
        // Reset button when audio finishes or errors
        const cleanup = () => {
            btn.innerHTML = originalIcon;
            btn.disabled = false;
            if (audioUrl) {
                URL.revokeObjectURL(audioUrl);
            }
            if (currentAudio) {
                try {
                    currentAudio.pause();
                    currentAudio.src = '';
                    currentAudio = null;
                } catch (e) {
                    console.log('Cleanup error:', e);
                }
            }
        };
        
        currentAudio.onended = cleanup;
        currentAudio.onerror = (e) => {
            console.error('Audio playback error:', e);
            cleanup();
        };
        
        // For short audio, we need to ensure full buffer load
        // Load the audio source first
        currentAudio.src = audioUrl;
        currentAudio.preload = 'auto';
        currentAudio.load();
        
        // Wait for loadeddata (has enough to start) AND add small buffer time
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Audio load timeout')), 10000);
            
            currentAudio.onloadeddata = async () => {
                clearTimeout(timeout);
                // Add 100ms buffer to ensure complete load for short clips
                await new Promise(r => setTimeout(r, 100));
                resolve();
            };
            currentAudio.onerror = (e) => {
                clearTimeout(timeout);
                reject(e);
            };
        });
        
        console.log('Starting playback...');
        await currentAudio.play();
        console.log('Playback started successfully');
    } catch (error) {
        console.error('TTS Error:', error);
        alert(`TTS Error: ${error.message}`);
        btn.innerHTML = originalIcon;
        btn.disabled = false;
        if (audioUrl) {
            URL.revokeObjectURL(audioUrl);
        }
        if (currentAudio) {
            currentAudio = null;
        }
    }
}

function autoResize(element) {
    if (!element) return;
    const minHeight = element.id === 'input-text' ? 150 : 180;
    
    // Save current overflow state
    const savedOverflow = element.style.overflow;
    
    // Temporarily hide overflow to get accurate scrollHeight
    element.style.overflow = 'hidden';
    
    // Reset height to minimum to allow shrinking
    element.style.height = minHeight + 'px';
    
    // Get the actual content height
    const scrollHeight = element.scrollHeight;
    
    // Set to the larger of scrollHeight or minHeight
    const newHeight = Math.max(scrollHeight, minHeight);
    element.style.height = newHeight + 'px';
    
    // Restore overflow
    element.style.overflow = savedOverflow;
}

// Run init immediately
init();

// Initialize auto-resize after DOM is fully ready
document.addEventListener('DOMContentLoaded', () => {
    if (inputText) autoResize(inputText);
    if (outputContent && outputContent.value) autoResize(outputContent);
});