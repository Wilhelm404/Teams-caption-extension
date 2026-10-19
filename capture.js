// ============================================================================
// Teams Live Caption Capture - Content Script
// Scrapes live captions from the Teams web app DOM and manages capture state.
// ============================================================================

// --- State ---
let capturedMessages = new Map();   // uniqueId -> { author, text, firstSeen, lastUpdated }
let processedIds = new Set();      // Track finalized message IDs
let captionsPresent = false;
let autoDownloadTriggered = false;

let captureIntervalId = null;
let finalizeIntervalId = null;
let monitorIntervalId = null;
let autoEnableIntervalId = null;

let isRunning = true;
let captureIntervalMs = 10000;     // default 10 seconds

// Stable element identity for the uniqueId fallback (replaces DOM coordinates).
// A WeakMap gives each container element a persistent id for its whole lifetime,
// so caption scrolling no longer corrupts the identity mapping.
const containerIdMap = new WeakMap();  // DOM element -> stable id string
let containerIdCounter = 0;

// Auto-enable live captions state
let autoEnableCaptions = true;   // user preference: auto-click "turn on captions" when in a meeting
let enableAttempts = 0;          // retry counter (reset once captions appear)
let enableInProgress = false;    // guard against concurrent attempts
let captionsEnableDone = false;  // we have issued the "turn on" click; stop retrying
const MAX_ENABLE_ATTEMPTS = 10;  // give up after this many tries

// --- Helpers ---

function normalize(text) {
    return text.replace(/\s+/g, ' ').trim();
}

function formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    return `[${hh}:${mm}:${ss}]`;
}

function isComplete(text) {
    // A caption is "complete" if it ends with sentence-ending punctuation (EN/CN)
    return /[.!?。！？]$/.test(text) && text.length > 2;
}

/**
 * Generate a unique ID for a caption container element.
 * Priority:
 *   1. avatar-{id} span id (most reliable)
 *   2. author + stable per-element id (WeakMap-backed, scroll-safe)
 *   3. author + sequential counter (last resort)
 *
 * The fallback no longer uses DOM coordinates (getBoundingClientRect), which
 * changed when captions scrolled and could split a single caption into
 * multiple records.
 */
function getUniqueId(container) {
    const avatarSpan = container.querySelector('span[id^="avatar-"]');
    if (avatarSpan) return avatarSpan.id;

    const author = container.querySelector('[data-tid="author"]')?.textContent.trim() || 'unknown';
    const textEl = container.querySelector('[data-tid="closed-caption-text"]');
    if (textEl) {
        // Stable identity for the life of this DOM element.
        let elId = containerIdMap.get(container);
        if (!elId) {
            elId = `el-${++containerIdCounter}`;
            containerIdMap.set(container, elId);
        }
        return `${author}-${elId}`;
    }
    return `${author}-seq-${Array.from(document.querySelectorAll('.fui-ChatMessageCompact')).indexOf(container)}`;
}

// --- Caption Detection ---

function checkCaptionsPresence() {
    // The captions panel exists as soon as live captions are turned on — text
    // only fills in once someone speaks, so we must NOT require text to be present.
    const wrapper = document.querySelector('[data-tid="closed-caption-renderer-wrapper"]');
    const anyCaptionEl = document.querySelector('[data-tid^="closed-caption"]');
    return wrapper !== null || anyCaptionEl !== null;
}

// --- Auto-Enable Live Captions ---

/**
 * Detect whether the user has actually joined a meeting (vs. pre-join screen,
 * lobby, or the chat view). Any in-meeting call control signal counts.
 */
function isInMeeting() {
    return document.querySelector('[data-tid="call-controls"]') !== null ||
           document.querySelector('[data-tid="callingButtons-showMoreBtn"]') !== null ||
           document.querySelector('[data-tid="callingButtons-moreBtn"]') !== null ||
           findMoreButton() !== null;
}

/**
 * Locate the "More actions" (three-dots) button in the meeting control bar.
 * Teams has changed its data-tid over time, so try several known selectors
 * plus attribute/text fallbacks.
 */
function findMoreButton() {
    const selectors = [
        '[data-tid="callingButtons-showMoreBtn"]',
        '[data-tid="callingButtons-moreBtn"]',
        '[data-tid="callingButtons-more"]',
        '[data-tid="callingButtons-overflowBtn"]',
        '[data-tid="callingButtons-overflow"]',
        'button[aria-label="More actions"]',
        'button[aria-label="More options"]',
        'button[aria-label="更多操作"]',
        'button[aria-label="更多选项"]'
    ];
    for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) return el;
    }

    // Fallback: scan buttons whose aria-label mentions "more"/"更多".
    const buttons = document.querySelectorAll('button[aria-label]');
    for (const b of buttons) {
        const label = (b.getAttribute('aria-label') || '').trim();
        if (/^(more|更多|\.\.\.|…)/i.test(label) ||
            /more actions/i.test(label) ||
            /更多操作/.test(label)) {
            return b;
        }
    }
    return null;
}

/**
 * Click the captions toggle, but only if it currently indicates captions are OFF.
 * The same item shows "Show live captions" / "开启实时字幕" (off → click to enable)
 * or "Hide live captions" / "关闭实时字幕" (on → click to disable). Clicking the
 * "Hide" variant would disable captions, so guard against it.
 */
function handleCaptionsItem(item, location) {
    const label = (item.getAttribute('aria-label') || item.textContent || '').trim();
    const isAlreadyOn = /^hide\s+live\s+captions/i.test(label) ||
                        /关闭实时字幕/.test(label) ||
                        /關閉即時字幕/.test(label) ||
                        /隐藏实时字幕/.test(label) ||
                        /隐藏字幕/.test(label);
    if (isAlreadyOn) {
        console.log(`[auto-captions] Captions already enabled (label: "${label}") in ${location}; closing menu`);
        document.body.click(); // dismiss the menu without changing state
        return;
    }
    item.click();
    captionsEnableDone = true;  // we issued the "turn on" click — stop retrying
    console.log(`[auto-captions] Clicked captions item in ${location} (label: "${label}") — auto-enable finished`);
}

/**
 * Dump candidate elements to the console to help diagnose a missing button.
 * Lists data-tid values and aria-labels that mention captions/more/calling.
 */
function dumpCandidateElements() {
    const seenTids = new Set();
    document.querySelectorAll('[data-tid]').forEach(el => {
        const tid = el.getAttribute('data-tid');
        if (/caption|more|calling|overflow|subtitle|transcript/i.test(tid)) {
            seenTids.add(tid);
        }
    });
    console.log('[auto-captions][diagnose] data-tid candidates:', Array.from(seenTids).sort());

    const labels = new Set();
    document.querySelectorAll('button[aria-label], [role="menuitem"][aria-label]').forEach(el => {
        const label = (el.getAttribute('aria-label') || '').trim();
        if (/caption|字幕|more|更多|\.\.\.|…/i.test(label)) {
            labels.add(label);
        }
    });
    console.log('[auto-captions][diagnose] aria-label candidates:', Array.from(labels).sort());
}

/**
 * Try to auto-enable live captions by opening the "More actions" menu and
 * clicking the "Turn on live captions" item.
 * Returns true if a captions-related element appeared after clicking.
 */
function tryEnableCaptions() {
    if (enableInProgress) return false;
    enableInProgress = true;

    try {
        const moreBtn = findMoreButton();
        if (!moreBtn) {
            console.log('[auto-captions] More-actions button not found');
            dumpCandidateElements();
            return false;
        }

        moreBtn.click();

        // The menu renders asynchronously; wait a tick before looking for the item.
        setTimeout(() => {
            try {
                let item = findCaptionsMenuItem();
                if (item) {
                    handleCaptionsItem(item, 'main menu');
                    return;
                }

                // Captions may live in a "Language and speech" submenu (newer UI).
                // Fluent UI uses a hover-triggered flyout, so dispatch mouse events too.
                const langItem = findLanguageSpeechMenuItem();
                if (langItem) {
                    console.log('[auto-captions] Captions not in main menu; opening "Language and speech" submenu');
                    ['mouseenter', 'mouseover', 'pointerenter'].forEach((evt) => {
                        langItem.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }));
                    });
                    langItem.click();

                    // Submenu renders async too; retry lookup for the captions item.
                    setTimeout(() => {
                        const subItem = findCaptionsMenuItem();
                        if (subItem) {
                            handleCaptionsItem(subItem, 'submenu');
                        } else {
                            console.log('[auto-captions] Captions item still not found in submenu');
                            dumpMenuItems();
                        }
                    }, 500);
                    return;
                }

                console.log('[auto-captions] Captions menu item not found; closing menu');
                dumpMenuItems();
                document.body.click(); // dismiss the menu
            } catch (err) {
                console.warn('[auto-captions] click error:', err);
            }
        }, 300);

        return true;
    } catch (err) {
        console.warn('[auto-captions] enable error:', err);
        return false;
    } finally {
        enableInProgress = false;
    }
}

/**
 * Dump the currently visible menu items (aria-label + text) to diagnose
 * why the captions item wasn't matched.
 */
function dumpMenuItems() {
    const items = document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], .fui-MenuItem, button');
    const seen = new Set();
    for (const el of items) {
        const label = (el.getAttribute('aria-label') || el.textContent || '').trim();
        if (label && label.length < 60) seen.add(label);
    }
    console.log('[auto-captions][diagnose] visible menu items:', Array.from(seen));
}

/**
 * Locate the "Language and speech" submenu item (the parent of captions in
 * recent Teams UI). Covers English + Chinese labels.
 */
function findLanguageSpeechMenuItem() {
    const items = document.querySelectorAll('button, [role="menuitem"], [role="menuitemradio"]');
    for (const el of items) {
        const text = (el.getAttribute('aria-label') || el.textContent || '').trim();
        if (!text) continue;
        if (/language\s+and\s+speech/i.test(text) ||
            /语言和语音/.test(text) ||
            /語言和語音/.test(text) ||
            /语言与语音/.test(text)) {
            return el;
        }
    }
    return null;
}

/**
 * Locate the "Turn on live captions" menu item across Teams UI variants.
 * Covers English and Chinese (Simplified/Traditional) labels, plus a
 * data-tid fallback. Teams updates labels often, so keep this list loose.
 */
function findCaptionsMenuItem() {
    const menuItems = document.querySelectorAll('button, [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="switch"], [role="checkbox"]');
    for (const el of menuItems) {
        const text = (el.getAttribute('aria-label') || el.textContent || '').trim();
        if (!text) continue;

        // Toggle label matches: covers "Show live captions" (off), "Hide live
        // captions" (on), plus Chinese variants. handleCaptionsItem() decides
        // whether clicking is safe based on the label.
        if (/turn\s+on\s+live\s+captions/i.test(text) ||
            /show\s+live\s+captions/i.test(text) ||
            /hide\s+live\s+captions/i.test(text) ||
            /开启实时字幕/.test(text) ||
            /关闭实时字幕/.test(text) ||
            /關閉即時字幕/.test(text) ||
            /打开实时字幕/.test(text) ||
            /打开字幕/.test(text) ||
            /开启字幕/.test(text) ||
            /实时字幕/.test(text)) {
            return el;
        }

        // data-tid fallback
        if (el.getAttribute('data-tid') === 'live-captions-menu-item') {
            return el;
        }
    }
    return null;
}

/**
 * Main auto-enable routine, run on a timer.
 * If we're in a meeting but captions are off and the feature is enabled,
 * retry until captions appear or we hit the attempt limit.
 */
function autoEnableCaptionsRoutine() {
    if (!autoEnableCaptions) return;

    // Captions are on (manually or by us) — record success and stop retrying.
    if (checkCaptionsPresence()) {
        if (!captionsEnableDone) {
            captionsEnableDone = true;
            console.log('[auto-captions] Captions detected active — auto-enable finished');
        }
        enableAttempts = 0;
        return;
    }

    // Captions are off. If we're not in a meeting right now (pre-join, lobby,
    // or we left), reset state so a (re)joined meeting gets a fresh attempt.
    if (!isInMeeting()) {
        if (captionsEnableDone || enableAttempts !== 0) {
            captionsEnableDone = false;
            enableAttempts = 0;
            console.log('[auto-captions] Not in meeting — reset auto-enable state');
        }
        return;
    }

    // In a meeting, captions off, and we haven't successfully enabled yet.
    if (captionsEnableDone) return;  // safety: we already issued the click

    if (enableAttempts >= MAX_ENABLE_ATTEMPTS) return;  // gave up

    enableAttempts++;
    console.log(`[auto-captions] Attempt ${enableAttempts}/${MAX_ENABLE_ATTEMPTS} to enable captions`);
    tryEnableCaptions();
}

// --- Core Capture Logic ---

/**
 * Scan all visible caption containers and update the in-memory store.
 * New captions are added; existing ones have their text updated in place.
 */
function captureCurrentState() {
    const containers = document.querySelectorAll('.fui-ChatMessageCompact');
    const now = Date.now();

    containers.forEach(container => {
        const authorEl = container.querySelector('[data-tid="author"]');
        const textEl = container.querySelector('[data-tid="closed-caption-text"]');
        if (!authorEl || !textEl) return;

        const author = authorEl.textContent.trim();
        const text = normalize(textEl.textContent);
        if (!text) return;

        const uniqueId = getUniqueId(container);
        const existing = capturedMessages.get(uniqueId);

        if (existing) {
            existing.text = text;
            existing.lastUpdated = now;
        } else {
            capturedMessages.set(uniqueId, {
                author,
                text,
                firstSeen: now,
                lastUpdated: now
            });
        }
    });
}

/**
 * Mark complete-and-stable messages as finalized.
 * A message is finalized when it ends with punctuation AND
 * hasn't been updated for 3 seconds (stability check).
 */
function finalizeCompleteMessages() {
    const now = Date.now();
    const finalized = [];

    capturedMessages.forEach((data, id) => {
        if (processedIds.has(id)) return;

        const stable = (now - data.lastUpdated) > 3000;
        if (stable && isComplete(data.text)) {
            finalized.push({ id, author: data.author, text: data.text, timestamp: data.firstSeen });
            processedIds.add(id);
            console.log(`${formatTimestamp(data.firstSeen)} ${data.author}\n${data.text}`);
        }
    });

    finalized.sort((a, b) => a.timestamp - b.timestamp);
    return finalized;
}

// --- Data Access ---

function getAllFinalizedMessages() {
    const result = [];
    const sorted = Array.from(capturedMessages.entries())
        .sort((a, b) => a[1].firstSeen - b[1].firstSeen);

    sorted.forEach(([id, data]) => {
        if (processedIds.has(id) && isComplete(data.text)) {
            result.push({ author: data.author, text: data.text, timestamp: data.firstSeen });
        }
    });
    return result;
}

// --- Meeting Name Extraction ---

function getMeetingName() {
    try {
        const title = document.title;
        // "Meeting Name | Microsoft Teams"  or  "Chat | Meeting Name | Microsoft Teams"
        const match = title.match(/\|\s*([^|]+?)\s*\|\s*Microsoft Teams$/);
        if (match) {
            return match[1].trim().replace(/^Chat\s*\|\s*/, '');
        }
        const simple = title.match(/^([^|]+?)\s*\|\s*Microsoft Teams$/);
        if (simple) return simple[1].trim();
        return null;
    } catch {
        return null;
    }
}

// --- Download ---

function downloadTranscript(isAutoDownload = false) {
    // Force-finalize remaining complete messages
    capturedMessages.forEach((data, id) => {
        if (!processedIds.has(id) && isComplete(data.text)) {
            processedIds.add(id);
            console.log(`${formatTimestamp(data.firstSeen)} ${data.author}\n${data.text}`);
        }
    });

    const finalized = getAllFinalizedMessages();

    // Deduplicate consecutive identical messages from same author
    const deduped = [];
    finalized.forEach(msg => {
        const last = deduped[deduped.length - 1];
        if (!last || last.author !== msg.author || last.text !== msg.text) {
            deduped.push(msg);
        }
    });

    if (deduped.length === 0) {
        console.log('No captions to download');
        return;
    }

    const content = deduped
        .map(msg => `${formatTimestamp(msg.timestamp)} ${msg.author}\n${msg.text}`)
        .join('\n\n');

    const fileTs = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const prefix = isAutoDownload ? 'auto_' : '';
    const meetingName = getMeetingName();
    const safeName = meetingName
        ? meetingName.replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, '_')
        : null;
    const filename = safeName
        ? `${prefix}teams_captions_${safeName}_${fileTs}.txt`
        : `${prefix}teams_captions_${fileTs}.txt`;

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    console.log(`${isAutoDownload ? 'Auto-' : ''}Downloaded ${deduped.length} captions → ${filename}`);

    if (isAutoDownload) {
        clearCaptions();
        autoDownloadTriggered = true;
    }
}

function clearCaptions() {
    capturedMessages.clear();
    processedIds.clear();
    console.log('All captions cleared');
}

// --- Captions Presence Monitor ---

function monitorCaptionsPresence() {
    const wasPresent = captionsPresent;
    captionsPresent = checkCaptionsPresence();

    // Meeting ended → auto-download
    if (wasPresent && !captionsPresent && !autoDownloadTriggered) {
        console.log('Captions disappeared — meeting may have ended. Auto-downloading...');
        downloadTranscript(true);
    }

    // New meeting → reset trigger
    if (captionsPresent && autoDownloadTriggered) {
        autoDownloadTriggered = false;
        console.log('New meeting detected — ready to capture');
    }
}

// --- Start / Stop ---

function startCapture(intervalMs) {
    stopCapture(); // clear any existing intervals

    captureIntervalId = setInterval(captureCurrentState, intervalMs);
    finalizeIntervalId = setInterval(finalizeCompleteMessages, 5000);
    monitorIntervalId = setInterval(monitorCaptionsPresence, 3000);
    autoEnableIntervalId = setInterval(autoEnableCaptionsRoutine, 4000);
    isRunning = true;
    console.log(`Capture started (interval: ${intervalMs}ms)`);
}

function stopCapture() {
    if (captureIntervalId) clearInterval(captureIntervalId);
    if (finalizeIntervalId) clearInterval(finalizeIntervalId);
    if (monitorIntervalId) clearInterval(monitorIntervalId);
    if (autoEnableIntervalId) clearInterval(autoEnableIntervalId);
    captureIntervalId = finalizeIntervalId = monitorIntervalId = autoEnableIntervalId = null;
    isRunning = false;
    console.log('Capture stopped');
}

// --- Popup <-> Content Script Communication ---

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    switch (request.action) {
        case 'getState':
            sendResponse({
                isRunning,
                messageCount: capturedMessages.size,
                processedCount: processedIds.size,
                captionsPresent: checkCaptionsPresence(),
                autoEnableCaptions
            });
            break;

        case 'setAutoEnable':
            autoEnableCaptions = !!request.enabled;
            if (autoEnableCaptions) enableAttempts = 0;
            sendResponse({ success: true, autoEnableCaptions });
            break;

        case 'checkCaptions':
            sendResponse({
                hasCaptions: checkCaptionsPresence(),
                captionCount: document.querySelectorAll('[data-tid="closed-caption-text"]').length,
                containerCount: document.querySelectorAll('.fui-ChatMessageCompact').length
            });
            break;

        case 'start':
            startCapture(request.interval || captureIntervalMs);
            sendResponse({ success: true });
            break;

        case 'stop':
            stopCapture();
            sendResponse({ success: true });
            break;

        case 'captureNow':
            captureCurrentState();
            sendResponse({ success: true });
            break;

        case 'clear':
            clearCaptions();
            sendResponse({ success: true });
            break;

        case 'download':
            downloadTranscript(false);
            sendResponse({ success: true });
            break;
    }
    return true; // keep channel open for async
});

// --- Tab Close / Visibility Handlers ---

window.addEventListener('beforeunload', (e) => {
    capturedMessages.forEach((data, id) => {
        if (!processedIds.has(id) && isComplete(data.text)) {
            processedIds.add(id);
        }
    });
    const finalized = getAllFinalizedMessages();
    if (finalized.length > 0) {
        console.log(`Tab closing — downloading ${finalized.length} captions...`);
        downloadTranscript(true);
        e.preventDefault();
        e.returnValue = 'Unsaved captions will be downloaded.';
        return e.returnValue;
    }
});

document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        setTimeout(() => {
            if (!checkCaptionsPresence() && capturedMessages.size > 0 && !autoDownloadTriggered) {
                console.log('Captions missing after tab restore — auto-downloading...');
                downloadTranscript(true);
            }
        }, 1000);
    }
});

// --- Keyboard Shortcuts ---

document.addEventListener('keydown', (e) => {
    if (!e.altKey) return;
    switch (e.key.toLowerCase()) {
        case 'd': downloadTranscript(false); break;
        case 'c': clearCaptions(); break;
        case 's': captureCurrentState(); console.log('Manual capture'); break;
        case 'e': tryEnableCaptions(); console.log('Manual auto-enable trigger'); break;
        case 'r': autoDownloadTriggered = false; console.log('Auto-download flag reset'); break;
    }
});

// --- Init ---

chrome.storage.local.get(['captureInterval', 'autoEnableCaptions'], (result) => {
    if (result.captureInterval) captureIntervalMs = result.captureInterval;
    if (typeof result.autoEnableCaptions === 'boolean') autoEnableCaptions = result.autoEnableCaptions;
    startCapture(captureIntervalMs);

    setTimeout(() => {
        captureCurrentState();
        captionsPresent = checkCaptionsPresence();
        console.log(`Teams Live Caption Capture ready. Captions: ${captionsPresent ? 'DETECTED' : 'not found'}`);
        console.log(`Auto-enable captions: ${autoEnableCaptions ? 'ON' : 'OFF'}`);
        console.log('Shortcuts: Alt+D=Download  Alt+C=Clear  Alt+S=CaptureNow');
    }, 1500);
});
