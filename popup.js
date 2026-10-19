// ============================================================================
// Teams Live Caption Capture - Popup Script
// Communication bridge between the popup UI and the content script.
// ============================================================================

let captureIntervalMs = 10000; // default 10s

// --- Helpers ---

async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
}

async function sendToContent(action, data = {}) {
    const tab = await getActiveTab();
    if (!tab) throw new Error('No active tab');
    return chrome.tabs.sendMessage(tab.id, { action, ...data });
}

function isTeamsPage(url) {
    return url && (
        url.includes('teams.microsoft.com') ||
        url.includes('teams.cloud.microsoft')
    );
}

// --- UI Elements ---

const $ = (id) => document.getElementById(id);

const statusDot = $('statusDot');
const captureState = $('captureState');
const messageCount = $('messageCount');
const noTeamsHint = $('noTeamsHint');
const startBtn = $('startBtn');
const stopBtn = $('stopBtn');
const downloadBtn = $('downloadBtn');
const captureNowBtn = $('captureNowBtn');
const clearBtn = $('clearBtn');
const intervalInput = $('captureInterval');
const autoEnableToggle = $('autoEnableToggle');

// --- UI Update ---

async function updateUI() {
    const tab = await getActiveTab();

    // Not a Teams page
    if (!tab || !isTeamsPage(tab.url)) {
        setStatus('inactive', 'Not Teams');
        messageCount.textContent = '0';
        noTeamsHint.classList.add('show');
        setAllEnabled(false);
        return;
    }

    noTeamsHint.classList.remove('show');

    try {
        const state = await sendToContent('getState');

        messageCount.textContent = state.messageCount || 0;
        setAllEnabled(true);

        if (!state.captionsPresent) {
            setStatus('inactive', 'No Captions');
            startBtn.disabled = true;
            stopBtn.disabled = true;
            captureNowBtn.disabled = true;
        } else if (state.isRunning) {
            setStatus('active', 'Capturing');
            startBtn.disabled = true;
            stopBtn.disabled = false;
        } else {
            setStatus('inactive', 'Paused');
            startBtn.disabled = false;
            stopBtn.disabled = true;
        }
    } catch {
        // Content script not loaded yet
        setStatus('inactive', 'Loading...');
        messageCount.textContent = '0';
        setAllEnabled(false);
        downloadBtn.disabled = false;
        clearBtn.disabled = false;
    }
}

function setStatus(type, text) {
    statusDot.className = 'status-dot' + (type === 'active' ? ' active' : '');
    captureState.textContent = text;
}

function setAllEnabled(enabled) {
    [startBtn, stopBtn, downloadBtn, captureNowBtn, clearBtn, intervalInput].forEach(
        el => el.disabled = !enabled
    );
}

// --- Event Handlers ---

startBtn.addEventListener('click', async () => {
    const sec = parseInt(intervalInput.value) || 10;
    captureIntervalMs = sec * 1000;
    await chrome.storage.local.set({ captureInterval: captureIntervalMs });
    await sendToContent('start', { interval: captureIntervalMs });
    updateUI();
});

stopBtn.addEventListener('click', async () => {
    await sendToContent('stop');
    updateUI();
});

captureNowBtn.addEventListener('click', async () => {
    await sendToContent('captureNow');
    setTimeout(updateUI, 500);
});

clearBtn.addEventListener('click', async () => {
    const ok = confirm('Clear all captured captions? This cannot be undone.');
    if (!ok) return;
    await sendToContent('clear');
    updateUI();
});

downloadBtn.addEventListener('click', async () => {
    await sendToContent('download');
});

intervalInput.addEventListener('change', async () => {
    const sec = parseInt(intervalInput.value) || 10;
    captureIntervalMs = sec * 1000;
    await chrome.storage.local.set({ captureInterval: captureIntervalMs });

    try {
        const state = await sendToContent('getState');
        if (state && state.isRunning) {
            await sendToContent('stop');
            await sendToContent('start', { interval: captureIntervalMs });
        }
    } catch { /* ignore */ }
});

autoEnableToggle.addEventListener('change', async () => {
    const enabled = autoEnableToggle.checked;
    await chrome.storage.local.set({ autoEnableCaptions: enabled });
    try {
        await sendToContent('setAutoEnable', { enabled });
    } catch { /* content script not ready; preference is persisted */ }
});

// --- Init ---

chrome.storage.local.get(['captureInterval', 'autoEnableCaptions'], (result) => {
    if (result.captureInterval) {
        captureIntervalMs = result.captureInterval;
        intervalInput.value = result.captureInterval / 1000;
    }
    if (typeof result.autoEnableCaptions === 'boolean') {
        autoEnableToggle.checked = result.autoEnableCaptions;
    }
    updateUI();
});

// Periodic refresh
setInterval(updateUI, 2000);
