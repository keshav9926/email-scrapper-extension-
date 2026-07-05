// popup.js
import { readExcel } from './excel/reader.js';

let loadedRows = null;

// DOM Elements
const fileInput = document.getElementById('fileInput');
const dropZone = document.getElementById('dropZone');
const uploadSection = document.getElementById('uploadSection');
const dashboardSection = document.getElementById('dashboardSection');
const statusBadge = document.getElementById('statusBadge');

const progressPercent = document.getElementById('progressPercent');
const progressBarFill = document.getElementById('progressBarFill');

const statTotal = document.getElementById('statTotal');
const statProcessed = document.getElementById('statProcessed');
const statFound = document.getElementById('statFound');
const statRemaining = document.getElementById('statRemaining');

const btnPause = document.getElementById('btnPause');
const btnResume = document.getElementById('btnResume');
const btnDownload = document.getElementById('btnDownload');
const btnStop = document.getElementById('btnStop');
const btnClearLogs = document.getElementById('btnClearLogs');
const consoleLogs = document.getElementById('consoleLogs');



// Initialize Dashboard
document.addEventListener('DOMContentLoaded', async () => {
  // 1. Drag and Drop events
  setupDragAndDrop();

  // 2. File select event
  fileInput.addEventListener('change', handleFileSelect);

  // 3. Active Sheet / URL events
  const activeTabZone = document.getElementById('activeTabZone');
  const activeTabPlaceholder = document.getElementById('activeTabPlaceholder');
  const detectedTabTitle = document.getElementById('detectedTabTitle');
  const btnScrapeActiveTab = document.getElementById('btnScrapeActiveTab');
  const sheetUrlInput = document.getElementById('sheetUrlInput');
  const btnLoadUrl = document.getElementById('btnLoadUrl');

  // Detect active tab and display "Active Tab Scrape" if it is a Google Sheet
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs[0];
    if (activeTab && activeTab.url && activeTab.url.includes("docs.google.com/spreadsheets")) {
      activeTabZone.classList.remove('hidden');
      activeTabPlaceholder.classList.add('hidden');
      detectedTabTitle.innerText = activeTab.title || "Unnamed Spreadsheet";
      
      const activeTabUrl = activeTab.url;
      const activeTabId = activeTab.id;
      btnScrapeActiveTab.addEventListener('click', () => {
        const resumeAfterUrl = document.getElementById('resumeAfterUrl').value.trim();
        const startFromRow = parseInt(document.getElementById('startFromRow').value.trim(), 10) || 0;
        const endAtRow = parseInt(document.getElementById('endAtRow').value.trim(), 10) || 0;
        handleLoadUrl(activeTabUrl, activeTabId, resumeAfterUrl, startFromRow, endAtRow);
      });
    }
  });

  btnLoadUrl.addEventListener('click', () => {
    const url = sheetUrlInput.value.trim();
    if (!url) {
      addLog("Please enter a valid Google Sheets URL.", "warn");
      return;
    }
    const resumeAfterUrl = document.getElementById('resumeAfterUrl').value.trim();
    const startFromRow = parseInt(document.getElementById('startFromRow').value.trim(), 10) || 0;
    const endAtRow = parseInt(document.getElementById('endAtRow').value.trim(), 10) || 0;
    handleLoadUrl(url, null, resumeAfterUrl, startFromRow, endAtRow);
  });


  // ? Quick Batch Launch buttons
  function fireBatchPreset(startRow, endRow) {
    document.getElementById('startFromRow').value = startRow > 1 ? startRow : '';
    document.getElementById('endAtRow').value    = endRow   > 0 ? endRow   : '';
    document.getElementById('resumeAfterUrl').value = '';

    if (loadedRows) {
      addLog(`Preset selected for local spreadsheet. Starting automation for rows ${startRow} → ${endRow || 'last'}...`, "info");
      chrome.runtime.sendMessage({ cmd: "start", rows: loadedRows, resumeAfterUrl: '', startFromRow: startRow, endAtRow: endRow }, (response) => {
        if (response && response.success) {
          addLog(`Automation started with local spreadsheet preset.`, "success");
          restoreSession(true);
        }
      });
      return;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs[0];
      const isGoogleSheet = activeTab && activeTab.url && activeTab.url.includes('docs.google.com/spreadsheets');
      const pastedUrl = document.getElementById('sheetUrlInput').value.trim();

      if (isGoogleSheet) {
        handleLoadUrl(activeTab.url, activeTab.id, '', startRow, endRow);
      } else if (pastedUrl) {
        handleLoadUrl(pastedUrl, null, '', startRow, endRow);
      } else {
        addLog('?? Paste a Google Sheets URL below, or open the sheet in a tab first.', 'warn');
      }
    });
  }

  document.getElementById('btnBatchA').addEventListener('click', () => fireBatchPreset(1, 2132));
  document.getElementById('btnBatchB').addEventListener('click', () => fireBatchPreset(3167, 0));

  // Mutual clearing for input fields to prevent conflicts
  const startInput = document.getElementById('startFromRow');
  const endInput = document.getElementById('endAtRow');
  const resumeInput = document.getElementById('resumeAfterUrl');

  startInput.addEventListener('input', () => {
    if (startInput.value) resumeInput.value = '';
  });
  endInput.addEventListener('input', () => {
    if (endInput.value) resumeInput.value = '';
  });
  resumeInput.addEventListener('input', () => {
    if (resumeInput.value) {
      startInput.value = '';
      endInput.value = '';
    }
  });

  // 5. Control Button events
  btnPause.addEventListener('click', handlePause);
  btnResume.addEventListener('click', handleResume);
  btnDownload.addEventListener('click', handleDownload);
  btnStop.addEventListener('click', handleStop);
  btnClearLogs.addEventListener('click', clearConsole);

  // 5. Listen for runtime messages (logs & status updates)
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);

  // 6. Restore current status
  await restoreSession(true);

  // Periodically poll status to keep background worker awake and refresh UI
  setInterval(async () => {
    await restoreSession(false);
  }, 5000);
});

function handleLoadUrl(url, tabId = null, resumeAfterUrl = "", startFromRow = 0, endAtRow = 0) {
  let msg;
  if (resumeAfterUrl) {
    msg = `Retrieving spreadsheet... will resume after URL: ${resumeAfterUrl}`;
  } else if (startFromRow > 1 && endAtRow > 0) {
    msg = `Retrieving spreadsheet... will process Sr. No. ${startFromRow} → ${endAtRow}`;
  } else if (startFromRow > 1) {
    msg = `Retrieving spreadsheet... will start from Sr. No. ${startFromRow}`;
  } else if (endAtRow > 0) {
    msg = `Retrieving spreadsheet... will process rows 1 → ${endAtRow}`;
  } else {
    msg = "Retrieving spreadsheet link...";
  }
  addLog(msg, "info");
  chrome.runtime.sendMessage({ cmd: "loadSheetUrl", url, tabId, resumeAfterUrl, startFromRow, endAtRow }, (response) => {
    if (chrome.runtime.lastError) {
      addLog("Failed to send message to background worker.", "error");
      return;
    }
    if (response && response.success) {
      addLog(`Successfully loaded spreadsheet. Starting automation for ${response.count} rows.`, "success");
      // Update local storage status and stats immediately
      restoreSession(true);
    } else {
      const errorMsg = (response && response.error) ? response.error : "Unknown error";
      addLog(`Failed to load link: ${errorMsg}`, "error");
    }
  });
}

/**
 * Checks current state of background scraper and restores UI state.
 */
async function restoreSession(shouldLog = false) {
  chrome.runtime.sendMessage({ cmd: "getStatus" }, (status) => {
    if (chrome.runtime.lastError) {
      if (shouldLog) addLog("Failed to connect to automation backend.", "error");
      return;
    }
    
    if (status && status.totalJobs > 0) {
      updateUI(status);
      if (shouldLog) {
        addLog(`Restored existing session: ${status.currentIndex}/${status.totalJobs} processed.`, "system");
      }
    }
  });
}

/**
 * Handle Drag & Drop styling and drop event
 */
function setupDragAndDrop() {
  ['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
    }, false);
  });

  dropZone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    if (files.length > 0) {
      fileInput.files = files;
      handleFileSelect();
    }
  });
}

/**
 * Handle File Selection and Parsing
 */
async function handleFileSelect() {
  const file = fileInput.files[0];
  if (!file) return;

  addLog(`Parsing sheet: "${file.name}"...`, "info");
  
  try {
    const arrayBuffer = await file.arrayBuffer();
    const rows = readExcel(arrayBuffer);
    
    if (rows.length === 0) {
      throw new Error("No readable rows found in the selected Excel file.");
    }
    
    // Validate rows
    const validRows = rows.filter(row => row.linkedin !== "");
    addLog(`Successfully parsed Excel file. Found ${validRows.length} rows with LinkedIn profiles.`, "success");
    
    if (validRows.length === 0) {
      addLog("Error: No rows containing a valid LinkedIn URL were detected.", "error");
      return;
    }

    loadedRows = validRows;

    // Send rows to background service worker to begin
    const resumeAfterUrl = document.getElementById('resumeAfterUrl').value.trim();
    const startFromRow = parseInt(document.getElementById('startFromRow').value.trim(), 10) || 0;
    const endAtRow = parseInt(document.getElementById('endAtRow').value.trim(), 10) || 0;
    chrome.runtime.sendMessage({ cmd: "start", rows: validRows, resumeAfterUrl, startFromRow, endAtRow }, (response) => {
      if (response && response.success) {
        let msg;
        if (resumeAfterUrl) {
          msg = `Automation started. Skipping rows up to and including URL: ${resumeAfterUrl}`;
        } else if (startFromRow > 1 && endAtRow > 0) {
          msg = `Automation started. Processing Sr. No. ${startFromRow} → ${endAtRow}.`;
        } else if (startFromRow > 1) {
          msg = `Automation started from Sr. No. ${startFromRow}. Skipped ${startFromRow - 1} rows.`;
        } else if (endAtRow > 0) {
          msg = `Automation started. Processing rows 1 → ${endAtRow}.`;
        } else {
          msg = "Automation loop started from the beginning.";
        }
        addLog(msg, "system");
      }
    });

  } catch (err) {
    addLog(`File reading error: ${err.message || err}`, "error");
    console.error(err);
  }
}

/**
 * Button Action Handlers
 */
function handlePause() {
  chrome.runtime.sendMessage({ cmd: "pause" }, () => {
    addLog("Pausing automation... waiting for current tab to resolve.", "warn");
  });
}

function handleResume() {
  chrome.runtime.sendMessage({ cmd: "resume" }, () => {
    addLog("Resuming automation.", "system");
  });
}

function handleDownload() {
  chrome.runtime.sendMessage({ cmd: "triggerDownload" }, (response) => {
    if (response && response.success && response.dataUrl) {
      try {
        const link = document.createElement('a');
        link.href = response.dataUrl;
        link.download = response.filename || "linkedin_emails_scraped.xlsx";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        addLog("Export generated. Excel file download initiated.", "success");
      } catch (err) {
        addLog(`Download failed: ${err.message || err}`, "error");
      }
    } else {
      const errorMsg = (response && response.error) ? response.error : "Unknown error";
      addLog(`Failed to export results: ${errorMsg}`, "error");
    }
  });
}

function handleStop() {
  if (confirm("Are you sure you want to stop the automation and clear all progress?")) {
    chrome.runtime.sendMessage({ cmd: "stop" }, () => {
      addLog("Scraper stopped. Progress cleared.", "error");
      resetUI();
    });
  }
}

/**
 * Real-time progress updates & logs receiver
 */
function handleRuntimeMessage(msg) {
  if (msg.cmd === "progress_update") {
    updateUI(msg.progress);
  } else if (msg.cmd === "log") {
    addLog(msg.log.message, msg.log.level);
  }
}

/**
 * Updates Dashboard UI Statistics
 */
function updateUI(state) {
  // Show dashboard, hide upload if running or total jobs > 0
  if (state.totalJobs > 0 || state.isRunning) {
    uploadSection.classList.add('hidden');
    dashboardSection.classList.remove('hidden');
  } else {
    resetUI();
    return;
  }

  // Status Badge
  if (state.isRunning) {
    statusBadge.innerText = "Running";
    statusBadge.className = "status-badge active";
    btnPause.classList.remove('hidden');
    btnResume.classList.add('hidden');
  } else {
    statusBadge.innerText = "Paused";
    statusBadge.className = "status-badge paused";
    btnPause.classList.add('hidden');
    btnResume.classList.remove('hidden');
  }

  // Counters
  const processed = state.currentIndex;
  const total = state.totalJobs;
  const remaining = total - processed;
  const found = state.resultsCount ? state.resultsCount : 0; // approximate/exact

  statTotal.innerText = total;
  statProcessed.innerText = processed;
  statRemaining.innerText = Math.max(0, remaining);
  
  // Update exact emails found from cached result count (will count items status: "Found")
  chrome.storage.local.get("scrape_results", (data) => {
    const resultsList = data.scrape_results || [];
    const foundCount = resultsList.filter(item => {
      return item.status === "Found" || (item.email && item.email.trim() !== "");
    }).length;
    statFound.innerText = foundCount;
  });

  // Progress Bar
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
  progressPercent.innerText = `${pct}%`;
  progressBarFill.style.width = `${pct}%`;
}

/**
 * Resets dashboard to upload state
 */
function resetUI() {
  uploadSection.classList.remove('hidden');
  dashboardSection.classList.add('hidden');
  statusBadge.innerText = "Idle";
  statusBadge.className = "status-badge";
  fileInput.value = "";
  loadedRows = null; // Clear cached local file rows
  
  // Clear all range/resume inputs
  document.getElementById('startFromRow').value = "";
  document.getElementById('endAtRow').value = "";
  document.getElementById('resumeAfterUrl').value = "";
}

/**
 * Add message line to the console logger
 */
function addLog(text, level = 'info') {
  const line = document.createElement('div');
  line.className = `log-line log-${level}`;
  
  const now = new Date();
  const timeStr = now.toTimeString().split(' ')[0];
  
  line.innerText = `[${timeStr}] ${text}`;
  consoleLogs.appendChild(line);
  consoleLogs.scrollTop = consoleLogs.scrollHeight;
}

/**
 * Clear console panel logs
 */
function clearConsole() {
  consoleLogs.innerHTML = '';
  addLog("Console cleared.", "system");
}


