// DOM Elements
const inputText = document.getElementById('input-text');
const cleanBtn = document.getElementById('clean-btn');
const actionBtns = document.querySelectorAll('.action-btn[data-action]');
const outputContainer = document.getElementById('output-container');
const outputContent = document.getElementById('output-content');
const loadingIndicator = document.getElementById('loading-indicator');
const emptyState = document.getElementById('empty-state');
// Copy button removed
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const closeModalBtn = document.getElementById('close-modal');
const saveSettingsBtn = document.getElementById('save-settings');
const cancelSettingsBtn = document.getElementById('cancel-settings');
const apiKeyInput = document.getElementById('api-key');
const openAiKeyInput = document.getElementById('openai-api-key');
const inputSpeakerBtn = document.getElementById('input-speaker-btn');
const outputSpeakerBtn = document.getElementById('output-speaker-btn');

// State
let apiKey = localStorage.getItem('gemini_api_key') || '';
let openAiKey = localStorage.getItem('openai_api_key') || '';
let lastAction = 'other';

// Initialize
function init() {
    if (apiKey) {
        apiKeyInput.value = apiKey;
    }
    if (openAiKey) {
        openAiKeyInput.value = openAiKey;
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

settingsBtn.addEventListener('click', openModal);
closeModalBtn.addEventListener('click', closeModal);
cancelSettingsBtn.addEventListener('click', closeModal);
saveSettingsBtn.addEventListener('click', saveSettings);

if (cleanBtn) {
    cleanBtn.addEventListener('click', () => {
        inputText.value = '';
        outputContent.value = '';
        outputContainer.style.display = 'none';
        emptyState.style.display = 'flex';
        inputText.focus();
    });
}

const ankiBtn = document.getElementById('anki-btn');

if (ankiBtn) {
    ankiBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isMobile = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(navigator.userAgent.toLowerCase());
        const front = inputText.value.trim().replace(/\n/g, '<br>');
        const back = outputContent.value.trim().replace(/\n/g, '<br>');

        if (!front && !back) {
             alert("Nothing to add.");
             return;
        }

        if (isMobile) {
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
    });
}

// Close Anki modal when clicking outside
window.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
        closeModal();
    }
});

// Functions
function openModal() {
    settingsModal.classList.add('show');
    apiKeyInput.value = apiKey; // Ensure input shows current saved key
    openAiKeyInput.value = openAiKey;
    apiKeyInput.focus();
}

function closeModal() {
    settingsModal.classList.remove('show');
}

function saveSettings() {
    const newKey = apiKeyInput.value.trim();
    const newOpenAiKey = openAiKeyInput.value.trim();
    
    if (newKey) {
        apiKey = newKey;
        localStorage.setItem('gemini_api_key', apiKey);
    }
    
    if (newOpenAiKey) {
        openAiKey = newOpenAiKey;
        localStorage.setItem('openai_api_key', openAiKey);
    }

    if (newKey || newOpenAiKey) {
        closeModal();
    } else {
         // Allow closing if keys are empty (maybe user wants to clear them), 
         // but previously it alerted. Let's just close.
         closeModal();
    }
}

async function handleAction(action) {
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

    try {
        const prompt = constructPrompt(action, text);
        const result = await callGeminiAPI(prompt, apiKey);
        showResult(result);
    } catch (error) {
        console.error('Error:', error);
        showResult(`Error: ${error.message || 'Something went wrong. Please check your API key and try again.'}`);
    }
}

// constructPrompt is now loaded from prompts.js via script tag in HTML
// callGeminiAPI is now loaded from api.js via script tag in HTML
// See prompts.js and api.js for the implementations

function showLoading() {
    emptyState.style.display = 'none';
    outputContainer.style.display = 'flex';
    // For editable textarea, we clear value and show overlapping loader
    outputContent.value = '';
    loadingIndicator.style.display = 'flex';

    // Disable buttons
    actionBtns.forEach(btn => btn.disabled = true);
}

function showResult(text) {
    loadingIndicator.style.display = 'none';
    outputContent.value = text;

    // Enable buttons
    actionBtns.forEach(btn => btn.disabled = false);
}

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
    
    const originalIcon = btn.innerHTML;
    // Show loading spinner
    btn.innerHTML = '<div class="spinner" style="width:14px;height:14px;border-width:2px;"></div>';
    btn.disabled = true;
    
    try {
        const audioUrl = await callOpenAITTS(text, openAiKey);
        const audio = new Audio(audioUrl);
        audio.play();
    } catch (error) {
        console.error('TTS Error:', error);
        alert(`TTS Error: ${error.message}`);
    } finally {
        btn.innerHTML = originalIcon;
        btn.disabled = false;
    }
}
