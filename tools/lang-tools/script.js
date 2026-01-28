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
        const btnElement = e.target.closest('.action-btn[data-action]');
        if (btnElement && btnElement.dataset.action) {
            handleAction(btnElement.dataset.action);
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
const ankiModal = document.getElementById('anki-modal');
const closeAnkiModalBtn = document.getElementById('close-anki-modal');
const ankiPcBtn = document.getElementById('anki-pc-btn');
const ankiMobileBtn = document.getElementById('anki-mobile-btn');

if (ankiBtn) {
    ankiBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isMobile = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(navigator.userAgent.toLowerCase());
        if (isMobile) {
            alert("mobile");
        } else {
            alert("PC");
        }
    });
}

if (closeAnkiModalBtn) {
    closeAnkiModalBtn.addEventListener('click', () => {
        ankiModal.classList.remove('show');
    });
}

if (ankiPcBtn) {
    ankiPcBtn.addEventListener('click', () => {
        alert("PC");
        ankiModal.classList.remove('show');
    });
}

if (ankiMobileBtn) {
    ankiMobileBtn.addEventListener('click', () => {
        alert("mobile");
        ankiModal.classList.remove('show');
    });
}

// Close Anki modal when clicking outside
window.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
        closeModal();
    }
    if (e.target === ankiModal) {
        ankiModal.classList.remove('show');
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
