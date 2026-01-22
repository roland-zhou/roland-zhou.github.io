// DOM Elements
const inputText = document.getElementById('input-text');
const cleanBtn = document.getElementById('clean-btn');
const actionBtns = document.querySelectorAll('.action-btn');
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

// State
let apiKey = localStorage.getItem('gemini_api_key') || '';

// Initialize
function init() {
    if (apiKey) {
        apiKeyInput.value = apiKey;
    }
}

// Event Listeners

actionBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
        // Find closest button in case user clicked icon span
        const btnElement = e.target.closest('.action-btn');
        if (btnElement) {
            const action = btnElement.dataset.action;
            handleAction(action);
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
        inputText.focus();
    });
}

// Close modal when clicking outside
window.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
        closeModal();
    }
});

// Functions
function openModal() {
    settingsModal.classList.add('show');
    apiKeyInput.value = apiKey; // Ensure input shows current saved key
    apiKeyInput.focus();
}

function closeModal() {
    settingsModal.classList.remove('show');
}

function saveSettings() {
    const newKey = apiKeyInput.value.trim();
    if (newKey) {
        apiKey = newKey;
        localStorage.setItem('gemini_api_key', apiKey);
        closeModal();
    } else {
        alert('Please enter a valid API Key.');
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
        const result = await callGeminiAPI(prompt);
        showResult(result);
    } catch (error) {
        console.error('Error:', error);
        showResult(`Error: ${error.message || 'Something went wrong. Please check your API key and try again.'}`);
    }
}

function constructPrompt(action, text) {
    switch (action) {
        case 'translate':
            return `Translate the following text to English (if it is not English) or to Chinese (if it is English).
If it can be translated into different meanings, please translate it into two or three different versions.
Strictly only output the translated content, without markdown formatting.

<text-to-be-translated>${text}</text-to-be-translated>`;
        case 'rewrite':
            return `I'm an English learner who's mother language is Chinese.
Please rewrite the following Chinglish text into good English.
You can show one casual version and one formal version to fit different scenarios.
Strictly only output the rewritten content, without markdown formatting.

<text-to-be-rewritten>${text}</text-to-be-rewritten>`;
        case 'explain':
            return `Explain the following text or concept in simple terms.
Strictly only output the explanation content, without markdown formatting, but can use simple line breaks to separate different points.

<text-to-be-explained>${text}</text-to-be-explained>`;
        default:
            return text;
    }
}

async function callGeminiAPI(prompt) {
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
