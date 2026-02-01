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
const apiKeyInput = document.getElementById('api-key');
const openAiKeyInput = document.getElementById('openai-api-key');
const inputSpeakerBtn = document.getElementById('input-speaker-btn');
const outputSpeakerBtn = document.getElementById('output-speaker-btn');
const ankiBtn = document.getElementById('anki-btn');

// State
let apiKey = localStorage.getItem('gemini_api_key') || '';
let openAiKey = localStorage.getItem('openai_api_key') || '';
let lastAction = 'other';

// Initialize
function init() {
    try {
        if (apiKey && apiKeyInput) {
            apiKeyInput.value = apiKey;
        }
        if (openAiKey && openAiKeyInput) {
            openAiKeyInput.value = openAiKey;
        }
        
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
            // If deferred, wait for it? Or just let it fail gracefully until needed.
            // We'll leave it for now; the button click checks again.
            console.log("SQL.js not yet loaded (deferred)");
        }
    } catch (e) {
        alert("Init Error: " + e.message);
    }
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
    settingsModal.classList.add('show');
    if (apiKeyInput) {
            apiKeyInput.value = apiKey; 
            apiKeyInput.focus();
    }
    if (openAiKeyInput) openAiKeyInput.value = openAiKey;
}

function closeModal() {
    if (settingsModal) settingsModal.classList.remove('show');
}

function saveSettings() {
    if (!apiKeyInput) return;
    const newKey = apiKeyInput.value.trim();
    const newOpenAiKey = openAiKeyInput ? openAiKeyInput.value.trim() : '';
    
    if (newKey) {
        apiKey = newKey;
        localStorage.setItem('gemini_api_key', apiKey);
    }
    
    if (newOpenAiKey) {
        openAiKey = newOpenAiKey;
        localStorage.setItem('openai_api_key', openAiKey);
    }

    closeModal();
}

async function handleAction(action) {
    try {
        if (!inputText) return;
        const text = inputText.value.trim();
        if (!text) {
            alert('Please enter some text first.');
            return;
        }

        if (!apiKey) {
            openModal();
            alert('Please save your Google Gemini API Key first.');
            return;
        }

        showLoading();

        // Assuming constructPrompt and callGeminiAPI are global from other scripts
        if (typeof constructPrompt === 'undefined' || typeof callGeminiAPI === 'undefined') {
                throw new Error("Helper scripts not loaded. Please refresh.");
        }
        const prompt = constructPrompt(action, text);
        const result = await callGeminiAPI(prompt, apiKey);
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
    if (!openAiKey) {
        openModal();
        alert('Please save your OpenAI API Key first for TTS.');
        return;
    }
    
    // Stop any currently playing audio
    if (currentAudio) {
        currentAudio.pause();
        currentAudio = null;
    }
    
    const originalIcon = btn.innerHTML;
    // Show loading spinner
    btn.innerHTML = '<div class="spinner" style="width:14px;height:14px;border-width:2px;"></div>';
    btn.disabled = true;
    
    try {
        if (typeof callOpenAITTS === 'undefined') throw new Error("API script not loaded.");
        const audioUrl = await callOpenAITTS(text, openAiKey);
        currentAudio = new Audio(audioUrl);
        
        // Preload the entire audio before playing
        currentAudio.preload = 'auto';
        
        // Reset button when audio finishes or errors
        currentAudio.onended = () => {
            btn.innerHTML = originalIcon;
            btn.disabled = false;
            URL.revokeObjectURL(audioUrl);
            currentAudio = null;
        };
        
        currentAudio.onerror = (e) => {
            console.error('Audio playback error:', e);
            btn.innerHTML = originalIcon;
            btn.disabled = false;
            URL.revokeObjectURL(audioUrl);
            currentAudio = null;
        };
        
        // Wait for audio to be ready before playing
        await new Promise((resolve, reject) => {
            currentAudio.oncanplaythrough = resolve;
            currentAudio.onerror = reject;
            currentAudio.load();
        });
        
        await currentAudio.play();
    } catch (error) {
        console.error('TTS Error:', error);
        alert(`TTS Error: ${error.message}`);
        btn.innerHTML = originalIcon;
        btn.disabled = false;
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